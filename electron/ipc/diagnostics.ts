import { createHash } from "node:crypto";
import path from "node:path";
import electron from "electron";
import { z } from "zod";
import {
  parseBootstrap,
  type BootstrapSource,
} from "../../shared/claudex-contract";
import type {
  ReplyFeedbackOutcome,
  ReportingStatus,
} from "../../shared/diagnostics-api";
import { preference } from "../../shared/settings-extras";
import type { AppContext, IpcHandle } from "../app/app-context";
import { DiagnosticsReporter, FetchedBootstrap } from "../support/diagnostics";
import { reporterClient } from "../support/diagnostics-support";
import type { RemoteHost } from "../remote/host";
import { requestJson, requestJsonResult } from "../sub2api/http";
import { deviceId } from "../sub2api/provision";

/** How often queued reports are sent. */
const flushIntervalMs = 60_000;
/** Settings → Privacy asks the service again when its answer is older. */
const statusMaxAgeMs = 5 * 60_000;

const feedbackInput = z.object({
  conversationId: z.string().min(1).max(500),
  turnId: z.string().min(1).max(500),
  rating: z.enum(["up", "down"]),
  categories: z.array(z.string().max(64)).max(20).optional(),
  comment: z.string().max(4000).optional(),
  reportUrl: z.string().max(2000).optional(),
  includeConversation: z.boolean().optional(),
});
const codeFeedbackInput = z.object({
  conversationId: z.string().min(1).max(500),
  comment: z.string().trim().min(1).max(4000),
  includeConversation: z.boolean().optional(),
  reportId: z.string().uuid().optional(),
});

function isBootstrapSource(value: unknown): value is BootstrapSource {
  const source = value as Partial<BootstrapSource> | undefined;
  return (
    !!source &&
    typeof source.current === "function" &&
    typeof source.refresh === "function" &&
    typeof source.onChange === "function"
  );
}

/**
 * The account's bootstrap: the one the remote host keeps current when it
 * offers one (`RemoteHost.bootstrap`, package C2), otherwise read here on
 * demand with the signed-in session.
 */
function bootstrapOf(ctx: AppContext, remote: RemoteHost) {
  const provided = (remote as unknown as { bootstrap?: unknown }).bootstrap;
  if (isBootstrapSource(provided)) return { source: provided, own: false };
  const device = deviceId(ctx.dataRoot);
  const source = new FetchedBootstrap((etag) =>
    remote.session.authorized(async (token) => {
      const result = await requestJsonResult(
        fetch,
        `${remote.accounts.baseUrl}/api/v1/claudex/bootstrap`,
        { token, deviceId: device, ifNoneMatch: etag },
      );
      return result.notModified
        ? { notModified: true as const }
        : {
            notModified: false as const,
            data: parseBootstrap(result.data),
            ...(result.etag ? { etag: result.etag } : {}),
          };
    }),
  );
  return { source, own: true };
}

type DiagnosticInput = Parameters<DiagnosticsReporter["record"]>[0];
const recorders = new WeakMap<object, (input: DiagnosticInput) => void>();

/**
 * Reports one diagnostic for the signed-in account (for callers outside
 * this domain, such as the remote host's device key issue). Does nothing
 * without a reporter, consent or the service collecting diagnostics.
 */
export function recordDiagnostic(ctx: object, input: DiagnosticInput) {
  try {
    recorders.get(ctx)?.(input);
  } catch {
    // A report never stops the work it reports on.
  }
}

/** The Codex version in the app-server's user agent ("codex_cli_rs/0.144.1 …"). */
export function codexVersionOf(userAgent: string | undefined) {
  const match = userAgent?.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
  return match ? match[1].slice(0, 32) : undefined;
}

/** A short, stable hash, so an MCP server's name is not sent. */
export function nameHash(name: string) {
  return createHash("sha256").update(name).digest("hex").slice(0, 12);
}

/**
 * A crash as a diagnostic: the error's name and the file names and lines of
 * its first three frames, never its message or any folder (the user's
 * name and home folder stay on this computer).
 */
export function crashReport(error: unknown, source: string): DiagnosticInput {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name)
      ? error.name
      : "Error";
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  const frames = stack
    .split("\n")
    .slice(1)
    .map((line) =>
      line.match(/([^/\\\s():]+\.[cm]?[jt]sx?):(\d+)(?::\d+)?\)?\s*$/),
    )
    .filter((match): match is RegExpMatchArray => !!match)
    .slice(0, 3)
    .map((match) => `${match[1]}:${match[2]}`);
  return {
    kind: "crash",
    code: name,
    message: frames.length ? `${name} at ${frames.join(", ")}` : name,
    context: { surface: source },
  };
}

/** A process that ended unexpectedly. */
export function processGoneReport(
  kind: string,
  details: { reason?: unknown; exitCode?: unknown; type?: unknown },
): DiagnosticInput | undefined {
  const reason = typeof details.reason === "string" ? details.reason : "";
  // Normal exits and the app's own kills are not crashes.
  if (!reason || reason === "clean-exit" || reason === "killed")
    return undefined;
  const type = typeof details.type === "string" ? details.type : kind;
  return {
    kind: "crash",
    code: `${type}_${reason}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    message: `${type} process ${reason}`,
    context: { surface: kind, reason },
  };
}

/**
 * An MCP server that did not start: a hash of its name (names can say
 * what the person works on) and the error's category, never its text.
 */
export function mcpStartFailure(
  name: string,
  error: string | undefined,
): DiagnosticInput {
  const text = (error ?? "").toLowerCase();
  const category = /timed? ?out|timeout/.test(text)
    ? "TIMEOUT"
    : /not found|enoent|no such file/.test(text)
      ? "NOT_FOUND"
      : /auth|401|403|unauthori[sz]ed|forbidden/.test(text)
        ? "AUTH"
        : /connect|econnrefused|network|dns/.test(text)
          ? "CONNECT"
          : "FAILED";
  return {
    kind: "mcp_start_failed",
    code: `MCP_${category}`,
    message: "",
    context: {
      feature: `mcp:${nameHash(name)}`,
      reason: category.toLowerCase(),
    },
  };
}

let crashWatch: { record?: (input: DiagnosticInput) => void } | undefined;
/**
 * Crashes of this process and its children, reported through the latest
 * `record`. Installed once and only in Electron's main process. Uses the
 * monitor event, so the app's own handling of an uncaught exception is
 * unchanged; unhandled rejections are logged as Electron logs them.
 */
function watchCrashes(recordCrash: (input: DiagnosticInput) => void) {
  if (crashWatch) {
    crashWatch.record = recordCrash;
    return;
  }
  if (!process.versions.electron) return;
  crashWatch = { record: recordCrash };
  const record = (input: DiagnosticInput) => {
    try {
      crashWatch?.record?.(input);
    } catch {
      // Reporting a crash must not cause another.
    }
  };
  process.on("uncaughtExceptionMonitor", (error) =>
    record(crashReport(error, "main")),
  );
  process.on("unhandledRejection", (reason) => {
    // The full reason (with its stack) stays in this computer's log, as
    // the default warning showed it; only crashReport's summary is sent.
    console.error("Unhandled rejection:", reason);
    record(crashReport(reason, "main-promise"));
  });
  const app = (electron as { app?: Electron.App }).app;
  app?.on?.("render-process-gone", (_event, _contents, details) => {
    const report = processGoneReport("renderer", details);
    if (report) record(report);
  });
  app?.on?.("child-process-gone", (_event, details) => {
    const report = processGoneReport("child", details);
    if (report) record(report);
  });
}

/**
 * Diagnostics and reply feedback reports (package C7). Nothing is collected
 * until the service's administrator turns collection on and the user agrees
 * in Settings → Privacy; ratings are stored locally by `setReplyFeedback`
 * (main.ts), which tells `ctx.onReplyRated` listeners. Local accounts have
 * no service to report to: nothing is sent.
 */
export function registerDiagnosticsHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  let reporter: DiagnosticsReporter | undefined;
  let owner: RemoteHost | undefined;
  let unsubscribeDeleted: (() => void) | undefined;
  /** Failed turns from before the app started are not reported. */
  const since = Date.now();
  /** The Codex version the engine reported at its last start. */
  let codexVersion: string | undefined;
  /** Turns reported per account, so signing out and in again repeats none. */
  const seenTurns = new Map<string, Set<string>>();

  /** The signed-in remote account's reporter; undefined otherwise. */
  const current = () => {
    const remote = ctx.remote;
    if (!remote?.ready || !ctx.activeAccount) {
      if (reporter) {
        reporter.stop();
        unsubscribeDeleted?.();
        reporter = owner = unsubscribeDeleted = undefined;
      }
      return undefined;
    }
    if (owner === remote && reporter) return reporter;
    reporter?.stop();
    unsubscribeDeleted?.();
    const store = ctx.store;
    const { source, own } = bootstrapOf(ctx, remote);
    const device = deviceId(ctx.dataRoot);
    const accountId = ctx.activeAccount.id;
    if (!seenTurns.has(accountId)) seenTurns.set(accountId, new Set());
    const next: DiagnosticsReporter = new DiagnosticsReporter({
      since,
      seenTurns: seenTurns.get(accountId),
      file: path.join(store.root, "diagnostics-queue.json"),
      bootstrap: source,
      consented: () => preference(store.settings, "helpImproveClaudex"),
      client: {
        ...reporterClient(ctx.appVersion),
        // Known once the engine started; read at every report.
        get codexVersion() {
          return codexVersion;
        },
      },
      post: (route, body) =>
        remote.session.authorized((token) =>
          requestJson(
            fetch,
            `${remote.accounts.baseUrl}/api/v1/claudex/${route}`,
            { method: "POST", token, body, deviceId: device },
          ),
        ),
      // The remote host announces its own bootstrap changes.
      onStatusChanged: own
        ? () => {
            if (reporter === next) ctx.push({ type: "service-changed" });
          }
        : undefined,
    });
    const feedback = ctx.replyFeedback;
    unsubscribeDeleted = feedback.onConversationDeleted((id) =>
      next.forgetConversation(id),
    );
    reporter = next;
    owner = remote;
    return next;
  };
  const conversation = (id: string) =>
    ctx.store.conversations.find((item) => item.id === id);

  const record = (input: DiagnosticInput) => void current()?.record(input);
  recorders.set(ctx, record);
  watchCrashes(record);
  /** MCP servers whose failed start was reported, by name and error, per engine start. */
  const mcpReported = new Set<string>();
  /** The engine's MCP servers that failed to start, each reported once per start. */
  const checkMcpStartup = () => {
    let startup: Map<string, { status: string; error?: string }> | undefined;
    try {
      startup = ctx.activeAccount ? ctx.engine?.mcpStartup : undefined;
    } catch {
      return;
    }
    for (const [name, state] of startup ?? []) {
      if (state.status !== "failed") continue;
      const key = `${name}\u0000${state.error ?? ""}`;
      if (mcpReported.has(key)) continue;
      mcpReported.add(key);
      record(mcpStartFailure(name, state.error));
    }
  };

  ctx.onSettingsChanged(() => current()?.consentChanged());
  ctx.onRefusal((refusal) =>
    current()?.recordRefusal(refusal, undefined, undefined, refusal.requestId),
  );
  ctx.onEvent((event) => {
    if (event.type === "conversation") {
      current()?.observeConversation(event.conversation);
      checkMcpStartup();
    }
    if (event.type === "engine") {
      if (event.engine.state === "ready")
        codexVersion = codexVersionOf(event.engine.version) ?? codexVersion;
      // A new start reports its failures again.
      if (event.engine.state === "starting") mcpReported.clear();
    }
  });
  ctx.onReplyRated(({ conversationId, turnId, rating }) =>
    current()?.rated(conversation(conversationId), turnId, rating),
  );
  setInterval(() => {
    checkMcpStartup();
    void current()
      ?.flush()
      .catch((error) =>
        console.error(
          "Diagnostics could not be sent:",
          error instanceof Error ? error.message : String(error),
        ),
      );
  }, flushIntervalMs).unref?.();

  handle("reportingStatus", async (): Promise<ReportingStatus | null> => {
    const status = await current()?.reportingStatus(statusMaxAgeMs);
    return status ? { ...status, codeSessionFeedback: true } : null;
  });
  handle(
    "submitReplyFeedback",
    async (raw: unknown): Promise<ReplyFeedbackOutcome> => {
      const input = feedbackInput.parse(raw);
      const active = current();
      if (!active) return { sent: false };
      const found = conversation(input.conversationId);
      const turn = found?.turns.find((item) => item.id === input.turnId);
      if (!found || turn?.status !== "completed")
        throw Error("Only completed replies can be rated.");
      return active.submitFeedback(found, input);
    },
  );
  handle(
    "submitCodeFeedback",
    async (raw: unknown): Promise<ReplyFeedbackOutcome> => {
      const input = codeFeedbackInput.parse(raw);
      const active = current();
      if (!active) return { sent: false };
      const found = conversation(input.conversationId);
      if (!found || found.mode !== "code")
        throw Error("Open a Code session to send feedback.");
      return active.submitCodeFeedback(found, input);
    },
  );
}
