import crypto from "node:crypto";
import type {
  ComputerUseAccessRequest,
  ComputerUseAppRef,
  ComputerUseTier,
  ComputerUseToolResult,
} from "../../shared/computer-use";
import { appKey, tierFor, tierLabels } from "./app-tiers";
import { text, failure, Refusal, str } from "./broker-support";
import type { ComputerUseBroker } from "./broker";
import type { KnownApp } from "./broker";

export async function listApps(
  this: ComputerUseBroker,
  conversationId: string,
): Promise<ComputerUseToolResult> {
  const apps = await this.driverApps(conversationId, true);
  const grants = this.grantsOf(conversationId);
  const lines = apps.map((app) => {
    const ref = this.refOf(app);
    const state = this.deniedBy(ref)
      ? "not available"
      : grants.has(appKey(app.id))
        ? `granted, ${tierLabels[grants.get(appKey(app.id))!.tier]}`
        : "not granted";
    const flags = [
      app.running ? "running" : undefined,
      app.frontmost ? "frontmost" : undefined,
    ].filter(Boolean);
    return `${app.name} — ${app.id} [${[...flags, state].join(", ")}]`;
  });
  return {
    content: [text(lines.join("\n") || "No apps found.")],
  };
}

export function listGranted(
  this: ComputerUseBroker,
  conversationId: string,
): ComputerUseToolResult {
  const grants = [...this.grantsOf(conversationId).values()];
  return {
    content: [
      text(
        grants.length
          ? grants
              .map(
                (grant) =>
                  `${grant.app.name} — ${grant.app.id} (${tierLabels[grant.tier]})`,
              )
              .join("\n")
          : "No apps are granted in this chat yet. Call request_access.",
      ),
    ],
  };
}

// -------------------------------------------------------------------------
// Access requests.

export function ask(
  this: ComputerUseBroker,
  request: ComputerUseAccessRequest,
): Promise<{ allow: string[] } | "deny"> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => finish("deny"),
      this.deps.accessTimeoutMs ?? 10 * 60_000,
    );
    timer.unref?.();
    const finish = (answer: { allow: string[] } | "deny") => {
      if (!this.pending.has(request.id)) return;
      clearTimeout(timer);
      this.pending.delete(request.id);
      this.deps.emit.resolved(request.id);
      resolve(answer);
    };
    this.pending.set(request.id, { request, finish });
    this.deps.emit.request(request);
  });
}

export async function requestAccess(
  this: ComputerUseBroker,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<ComputerUseToolResult> {
  if (
    !Array.isArray(args.apps) ||
    !args.apps.length ||
    args.apps.length > 10 ||
    !args.apps.every((app) => typeof app === "string" && app.trim())
  )
    throw new Refusal("apps must list 1 to 10 app names or ids.");
  const reason = str(args.reason, "reason", 1000).trim().slice(0, 300);
  const grants = this.grantsOf(conversationId);
  const clipboardHad = this.clipboardGrants.get(conversationId) ?? {
    read: false,
    write: false,
  };
  const clipboard = {
    read: args.clipboard_read === true && !clipboardHad.read,
    write: args.clipboard_write === true && !clipboardHad.write,
  };
  const lines: string[] = [];
  const ask: { app: KnownApp; tier: ComputerUseTier }[] = [];
  const deniedAutomatically: ComputerUseAppRef[] = [];
  for (const name of new Set(args.apps as string[])) {
    const app = await this.resolve(conversationId, name);
    if (!app) {
      lines.push(`${name}: not found. Use a name or id from list_apps.`);
      continue;
    }
    const denied = this.deniedBy(app);
    if (denied) {
      deniedAutomatically.push(this.refOf(app));
      lines.push(
        denied === "never"
          ? `${app.name}: never available to computer use.`
          : `${app.name}: denied by the person or their administrator.`,
      );
      continue;
    }
    const existing = grants.get(appKey(app.id));
    if (existing) {
      lines.push(
        `${app.name}: already granted (${tierLabels[existing.tier]}).`,
      );
      continue;
    }
    if (!ask.some((item) => appKey(item.app.id) === appKey(app.id)))
      ask.push({ app, tier: tierFor(app) });
  }
  if (ask.length || clipboard.read || clipboard.write) {
    const request: ComputerUseAccessRequest = {
      id: crypto.randomUUID(),
      conversationId,
      kind: "apps",
      reason,
      apps: await Promise.all(
        ask.map(async ({ app, tier }) => {
          const icon =
            app.path && this.deps.icon
              ? await this.deps.icon(app).catch(() => undefined)
              : undefined;
          return { app: this.refOf(app), tier, ...(icon ? { icon } : {}) };
        }),
      ),
      ...(deniedAutomatically.length ? { deniedAutomatically } : {}),
      ...(clipboard.read || clipboard.write ? { clipboard } : {}),
    };
    const answer = await this.ask(request);
    if (clipboard.read || clipboard.write) {
      if (answer === "deny")
        lines.push("Clipboard: the person didn't allow it.");
      else {
        this.clipboardGrants.set(conversationId, {
          read: clipboardHad.read || clipboard.read,
          write: clipboardHad.write || clipboard.write,
        });
        lines.push(
          `Clipboard: granted (${[clipboard.read && "read", clipboard.write && "write"].filter(Boolean).join(" and ")}).`,
        );
      }
    }
    const allowed = new Set(
      answer === "deny" ? [] : answer.allow.map((id) => appKey(id)),
    );
    for (const { app, tier } of ask) {
      if (allowed.has(appKey(app.id)) && !this.deniedBy(app)) {
        grants.set(appKey(app.id), { app, tier });
        lines.push(`${app.name}: granted (${tierLabels[tier]}).`);
      } else lines.push(`${app.name}: the person didn't allow it.`);
    }
  }
  return { content: [text(lines.join("\n"))] };
}

/**
 * The macOS permissions are missing: the card lists them with Open System
 * Settings; Deny and Ask again both answer, and the result says whether
 * they are granted now.
 */
export async function askPermissions(
  this: ComputerUseBroker,
  conversationId: string,
): Promise<ComputerUseToolResult> {
  await this.ask({
    id: crypto.randomUUID(),
    conversationId,
    kind: "permissions",
    apps: [],
  });
  if (this.deps.permissionsReady())
    return {
      content: [
        text(
          "The permissions are granted now. Call request_access again with the apps you need.",
        ),
      ],
    };
  return failure(
    "Claudex still doesn't have the macOS Accessibility and Screen Recording permissions. Don't call computer-use tools again this turn; tell the person what is still needed (a new Screen Recording grant takes effect after Claudex restarts) and continue once they say it's granted.",
  );
}

/** The person answered an access request in the window. */
export function answer(
  this: ComputerUseBroker,
  id: string,
  decision: { allow: string[]; deny: string[] } | "deny",
) {
  const pending = this.pending.get(id);
  if (!pending) throw new Error("This request was already answered.");
  if (decision === "deny") return pending.finish("deny");
  const asked = new Set(pending.request.apps.map((item) => item.app.id));
  pending.finish({
    allow: decision.allow.filter((appId) => asked.has(appId)),
  });
}

/** Requests waiting for an answer. */
export function requests(this: ComputerUseBroker): ComputerUseAccessRequest[] {
  return [...this.pending.values()].map((pending) => pending.request);
}

// -------------------------------------------------------------------------
// Full control.

export async function requestFullControl(
  this: ComputerUseBroker,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<ComputerUseToolResult> {
  const reason = str(args.reason, "reason", 1000).trim().slice(0, 300);
  if (!this.deps.policy().allowFullControl)
    throw new Refusal(
      "Your administrator doesn't allow full control. Use background actions.",
    );
  if (this.control?.conversationId === conversationId)
    return { content: [text("You already have full control.")] };
  const granted = [...this.grantsOf(conversationId).values()];
  if (!granted.length)
    throw new Refusal("Request access to the apps you need first.");
  if (this.deps.settings().mode !== "fullControl") {
    const answer = await this.ask({
      id: crypto.randomUUID(),
      conversationId,
      kind: "full-control",
      reason,
      apps: granted.map((grant) => ({
        app: this.refOf(grant.app),
        tier: grant.tier,
      })),
    });
    if (answer === "deny")
      return failure(
        "The person didn't allow full control. Continue with background actions or stop.",
      );
  }
  // The answer may have come after the turn ended or was stopped.
  const conversation = this.deps.conversation(conversationId);
  if (!conversation?.running || this.turns.get(conversationId)?.halted)
    throw new Refusal("The turn ended before full control started.");
  if (this.control)
    throw new Refusal("Another conversation has full control of the screen.");
  this.control = { conversationId };
  this.appCache = undefined;
  await this.deps.fullControl.begin(
    conversationId,
    granted.map((grant) => grant.app),
  );
  this.setActivity({
    conversationId,
    mode: "fullControl",
    startedAt: this.now(),
  });
  return {
    content: [
      text(
        "You have full control of the screen until you call release_full_control or the turn ends. The person can press Esc to stop you.",
      ),
    ],
  };
}

export async function releaseControl(this: ComputerUseBroker) {
  this.deps.teach?.hide();
  if (!this.control) return;
  this.control = undefined;
  this.appCache = undefined;
  await this.deps.fullControl.end(this.deps.settings().unhideApps);
  if (this.activity?.mode === "fullControl") this.setActivity(null);
}
