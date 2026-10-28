/**
 * Offline stand-in for the Electron preload bridge. It lets the real renderer
 * run in a plain browser with synthetic data: no account, model service,
 * Codex process or user history is touched.
 */
import { webHost } from "../../shared/host";
import { localeIds } from "../../shared/locales";
import {
  initialCloudEnvironment,
  type CloudEnvironmentConfig,
} from "../../shared/cloud-environments-api";
import { codeMismatch } from "../../shared/sign-in-errors";
import type {
  AppEvent,
  Conversation,
  DesktopAPI,
  Item,
  Project,
  Schedule,
  Settings,
  Snapshot,
  TerminalSessionInfo,
  Turn,
  PublicAccount,
  WorkingTreeChanges,
} from "../../shared/types";
import {
  approvalConversation,
  backgroundConversation,
  changesConversation,
  workflowConversation,
  mixedToolsConversation,
  planApprovalConversation,
  planConversation,
  appLineCount,
  workingTreeDiff,
  type ApprovalVariant,
} from "./agent-tool-fixtures";
import {
  fixtureRemoteImage,
  stateConversations,
  statesProject,
} from "./fixtures/conversation-states";
import { artifactConversations, fixtureBlobs } from "./fixtures/artifacts";
import { fixtureDomains } from "./fixtures/index";
import { nativeCliFixture } from "./fixtures/native-cli";
import { applyMenuAsyncFixture } from "./fixtures/menu-async";

const hour = 3_600_000;
const day = 24 * hour;
/** Fixed clock origin so repeated captures produce the same fixture. */
const origin = Date.UTC(2026, 8, 24, 9);

const recentTitles = [
  "Read-only terminal test",
  "Enable Safari cookies",
  "Disk space cleanup",
  "Keyboard repeat issue",
  "Passwordless SSH access",
  "Contract obligations review",
  "Monthly allowance summary",
  "Hello",
  "Workspace sync on a second machine",
  "Obstacle avoidance source lookup",
  "Local configuration audit",
  "Sandbox map with Three.js",
  "Server account recovery",
  "Simulation fork",
  "Object storage costs",
];
// Thirteen pinned rows, as in the reference captures, so list geometry lines up row for row.
const pinnedTitles = [
  "Claudex (cloud)",
  "Claudex",
  "Vision agent",
  "Simulator",
  "Hub",
  "Agent runtime",
  "Flash notes",
  "Ops channel",
  "Forum ops",
  "Academy",
  "Studio ops",
  "Switch codex service",
  "K12 simulation",
];

// Working folders for Code rows; the folder menu lists them as Recent.
const folders = [
  "claude-reference-diff-sandbox",
  "claudex",
  "claude-reference-edit-sandbox",
  "codex-client",
  "developer",
  "academy",
  "agent-runtime",
  "hub",
];

export function fixtureSettings(): Settings {
  return {
    theme: "dark",
    sidebarWidth: 242,
    name: "Ada",
    providers: [
      {
        id: "fixture",
        name: "Fixture service",
        baseUrl: "",
        protocol: "responses",
        model: "Opus 5.5",
        models: ["Opus 5.5", "Fable 5.1", "Sonnet 5", "Haiku 4.5", "Opus 5"],
      },
    ],
    activeProviderId: "fixture",
    effort: "medium",
    codeEffort: "xhigh",
    sandbox: "read-only",
    codeSandbox: "workspace-write",
    autoAcceptEdits: false,
    codePlanMode: false,
    instructions: "",
    // Two local MCP servers, so the Connectors submenu shows toggles.
    mcpServers: {
      docs: { command: "docs-mcp", enabled: true },
      browser: { command: "browser-mcp", enabled: true },
    },
  };
}

function turn(
  id: string,
  createdAt: number,
  prompt: string,
  items: Item[] = [],
): Turn {
  return { id, prompt, attachments: [], items, status: "completed", createdAt };
}
function conversation(
  index: number,
  title: string,
  mode: Conversation["mode"],
  pinned: boolean,
): Conversation {
  const updatedAt = origin - index * 7 * hour;
  const turns = Array.from({ length: 1 + (index % 4) }, (_, n) => ({
    ...turn(`t-${index}-${n}`, updatedAt - n * (5 + index) * hour, title, [
      { id: `m-${index}-${n}`, type: "agentMessage", text: "Done." },
    ]),
    // Deterministic per-turn usage so the Models chart has something to draw.
    inputTokens: 4_000 + ((index * 7 + n * 13) % 9) * 1_500,
    outputTokens: 180_000 + ((index * 11 + n * 5) % 13) * 95_000,
  }));
  // The first pinned Code task is still running, as in the reference captures.
  if (index === 0) turns[0] = { ...turns[0], status: "inProgress" };
  return {
    id: `c-${index}`,
    threadId: `thread-${index}`,
    title,
    mode,
    cwd:
      mode === "code"
        ? `/Users/fixture/${folders[index % folders.length]}`
        : undefined,
    providerId: "fixture",
    model: index % 3 ? "Opus 5.5" : "Opus 5",
    pinned,
    archived: false,
    createdAt: updatedAt - 3 * day,
    updatedAt,
    turns,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 180_000 * (index + 3),
    },
  };
}
/** A Code conversation whose shell command failed, matching the original exit-code test. */
function failedCommandConversation(): Conversation {
  const createdAt = origin - 2 * hour;
  return {
    id: "c-exit",
    threadId: "thread-exit",
    title: "Exit code test",
    mode: "code",
    cwd: "/Users/fixture/claudex",
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    turns: [
      turn(
        "t-exit",
        createdAt,
        "Run sh -c 'exit 7' and tell me the exit code.",
        [
          {
            id: "cmd-exit",
            type: "commandExecution",
            command: "sh -c 'exit 7'",
            cwd: "/Users/fixture/claudex",
            status: "failed",
            exitCode: 7,
            aggregatedOutput: "",
            lifecycleStatus: "failed",
            startedAt: createdAt + 1000,
            completedAt: createdAt + 1400,
          },
          {
            id: "msg-exit",
            type: "agentMessage",
            text: "The command exited with code **7**, as expected for `exit 7`.",
          },
        ],
      ),
    ],
  };
}

/**
 * The shared fixture's options. Package domains (usage, policy, billing,
 * voice, …) read their own URL parameters in `fixtures/<domain>.ts`.
 */
export interface FixtureOptions {
  /** Which conversations exist; "empty" starts with none. */
  history?: "full" | "empty";
  schedules?: Schedule[];
  /** A Sub2API plan name: the account becomes remote, with the Usage page. */
  plan?: string;
  /** Start signed out: local accounts, or a Sub2API service closed/open to registration, or with 2FA. */
  auth?: "local" | "remote" | "remote-open" | "remote-2fa";
  /** Adds the synthetic transcript-state conversations and their project. */
  states?: boolean;
  /** Adds "Long conversation" (c-long) with this many markdown turns, for typing-latency checks. */
  longTurns?: number;
  /** Adds chats whose generated files exercise the file viewer's previews. */
  artifacts?: boolean;
  /** Adds an unread chat, an unread Code task and one waiting for approval. */
  rowStates?: boolean;
  /** Which request the "Interface reference test" session is waiting on. */
  approval?: ApprovalVariant;
  /** Start in Code Plan mode (the plan approval card shows). */
  planMode?: boolean;
  /** The web's sandbox network ceiling (Settings → Capabilities): none|trusted|custom|full. */
  sandboxNetwork?: "none" | "trusted" | "custom" | "full";
  /** The web's runner keeps the user's remote connectors (Add custom connector shows). */
  customConnectors?: boolean;
}

export function fixtureSnapshot(options: FixtureOptions = {}): Snapshot {
  const conversations =
    options.history === "empty"
      ? []
      : [
          ...pinnedTitles.map((title, i) =>
            conversation(i, title, "code", true),
          ),
          // The reference Chat sidebar pins a single untitled chat.
          conversation(
            pinnedTitles.length + recentTitles.length,
            "Untitled",
            "chat",
            true,
          ),
          failedCommandConversation(),
          ...recentTitles.map((title, i) =>
            conversation(
              pinnedTitles.length + i,
              title,
              i % 2 ? "chat" : "code",
              false,
            ),
          ),
        ];
  if (options.states) conversations.unshift(...stateConversations(origin));
  if (options.longTurns)
    conversations.unshift(longConversation(options.longTurns, origin));
  if (options.artifacts)
    conversations.unshift(...artifactConversations(origin));
  const projects: Project[] = options.states ? [statesProject] : [];
  const approvals: Snapshot["approvals"] = [];
  if (options.rowStates && conversations.length) {
    const recent = conversations.filter((c) => !c.pinned);
    const code = recent.filter((c) => c.mode === "code");
    code[0].unread = true;
    recent.find((c) => c.mode === "chat")!.unread = true;
    approvals.push({
      id: "approval-fixture",
      conversationId: code[2].id,
      method: "item/commandExecution/requestApproval",
      params: { command: "npm test" },
    });
  }
  const agentTools = approvalConversation(
    origin - 20 * 60_000,
    options.approval ?? "edit",
  );
  if (options.history !== "empty")
    conversations.splice(
      pinnedTitles.length + 1,
      0,
      agentTools.conversation,
      changesConversation(origin - 25 * 60_000),
      workflowConversation(origin - 30 * 60_000),
      backgroundConversation(origin - 40 * 60_000),
      planConversation(origin - 50 * 60_000),
      mixedToolsConversation(origin - 55 * 60_000),
      planApprovalConversation(origin - 58 * 60_000),
    );
  return {
    artifactLibrary: { version: 1, copies: [], pinned: [] },
    dismissedBackgroundTasks: [],
    artifactShares: [],
    settings: { ...fixtureSettings(), codePlanMode: Boolean(options.planMode) },
    ...(options.sandboxNetwork || options.customConnectors
      ? {
          host: {
            ...webHost,
            ...(options.sandboxNetwork
              ? { sandboxNetwork: options.sandboxNetwork }
              : {}),
            capabilities: {
              ...webHost.capabilities,
              customConnectors: Boolean(options.customConnectors),
            },
          },
        }
      : {}),
    conversations,
    projects,
    engine: { state: "ready", version: "Codex fixture" },
    approvals:
      options.history === "empty"
        ? approvals
        : [...approvals, agentTools.approval],
    platform: "darwin",
    replyFeedback: {},
  };
}

/** Base64 of UTF-8 text, as the terminal bridge carries it. */
function base64(text: string) {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  );
}

/**
 * Builds the fake bridge. Mutating calls update the in-memory snapshot and
 * emit events like the real app; each package's `fixtures/<domain>.ts` then
 * adds or replaces the calls it owns (fixtures/index.ts).
 */
export function createFixtureDesktop(
  options: FixtureOptions = {},
  params = new URLSearchParams(),
): DesktopAPI {
  const state = fixtureSnapshot(options);
  const sidebarWidth = Number(params.get("sidebarWidth"));
  if (
    params.has("sidebarWidth") &&
    Number.isFinite(sidebarWidth) &&
    sidebarWidth >= 208 &&
    sidebarWidth <= 480
  )
    state.settings.sidebarWidth = sidebarWidth;
  let environments: CloudEnvironmentConfig[] =
    params.get("environments") === "some"
      ? [
          {
            ...structuredClone(initialCloudEnvironment),
            name: "Preview workspace",
          },
        ]
      : [];
  // ?platform=win32 or linux draws the window chrome of those systems.
  const platform = params.get("platform");
  if (platform === "win32" || platform === "linux") state.platform = platform;
  // ?theme=light or system: the account's theme (light-mode audits).
  const theme = params.get("theme");
  if (theme === "light" || theme === "system")
    state.settings = { ...state.settings, theme };
  const locale = params.get("locale");
  // Explicit nondefault appearance for cold-start frame checks. These are
  // real Settings fields, not a DOM/CSS override in the acceptance page.
  if (params.get("appearance") === "large-system") {
    state.settings.chatFont = "sans";
    state.settings.transcriptTextSize = "l";
    state.settings.transcriptWidth = "l";
    state.settings.interfaceFont = "system";
  }
  if (locale && localeIds.some((id) => id === locale))
    state.settings.locale = locale;
  // ?cowork=<id> makes that conversation a Cowork task (its composer).
  const cowork = state.conversations.find((c) => c.id === params.get("cowork"));
  if (cowork) cowork.mode = "cowork";
  const listeners = new Set<(event: AppEvent) => void>();
  const emit = (event: AppEvent) =>
    listeners.forEach((listener) => listener(event));
  const find = (id: string) => {
    const found = state.conversations.find((c) => c.id === id);
    if (!found) throw new Error("Conversation not found.");
    return found;
  };
  const updated = (c: Conversation) => {
    emit({ type: "conversation", conversation: structuredClone(c) });
    return structuredClone(c);
  };
  const account: PublicAccount = {
    id: "fixture-account",
    email: "fixture@example.invalid",
    name: "Ada",
    ...(options.plan ? { plan: options.plan, remote: true } : {}),
  };
  let signedIn = !options.auth;
  const remotePolicy = options.auth?.startsWith("remote")
    ? {
        siteName: "Acme AI",
        registrationEnabled: options.auth === "remote-open",
        emailVerification: options.auth === "remote-open",
        invitationCode: options.auth === "remote-open",
        promoCode: options.auth === "remote-open",
        captchaRequired: false,
        emailDomains: [],
      }
    : undefined;
  let stoppedSleep = false;
  // Responses the approval card sent, for scripted checks.
  const responses: { id: string | number; result: unknown }[] = [];
  (globalThis as { fixtureApprovals?: typeof responses }).fixtureApprovals =
    responses;
  let fullName = "Ada";
  // Terminal tabs: a shell prompt that echoes what is typed; nothing runs.
  const terminals = new Map<string, TerminalSessionInfo[]>();
  let terminalCount = 0;
  const terminalPrompt = (cwd: string) =>
    `fixture@claudex ${cwd.split("/").pop() || "~"} % `;
  const startTerminal = (conversationId: string) => {
    const cwd =
      state.conversations.find((c) => c.id === conversationId)?.cwd ??
      "/Users/fixture";
    const session: TerminalSessionInfo = {
      id: `terminal-${++terminalCount}`,
      conversationId,
      title: "zsh",
      cwd,
      running: true,
      outputBase64: base64(terminalPrompt(cwd)),
      sequence: 0,
    };
    terminals.set(conversationId, [
      ...(terminals.get(conversationId) ?? []),
      session,
    ]);
    return session;
  };
  // Explicit offline first-snapshot frame capture; no delay by default.
  const requestedSnapshotDelay = Number(params.get("snapshotDelay"));
  const snapshotDelay = Number.isFinite(requestedSnapshotDelay)
    ? Math.min(5_000, Math.max(0, requestedSnapshotDelay))
    : 0;
  let firstSnapshotReady = snapshotDelay === 0;
  let firstSnapshotWait: Promise<void> | undefined;
  const api: Partial<DesktopAPI> = {
    authStatus: async () =>
      signedIn
        ? { account, hasAccounts: true }
        : { hasAccounts: true, remote: remotePolicy },
    registerAccount: async () => ((signedIn = true), account),
    loginAccount: async () => {
      if (options.auth === "remote-2fa")
        return { twoFactorRequired: true, maskedEmail: "z***@example.invalid" };
      signedIn = true;
      return account;
    },
    completeTwoFactor: async (code) => {
      if (code !== "123456") throw Error(codeMismatch);
      signedIn = true;
      return account;
    },
    sendVerificationCode: async () => ({ countdown: 60 }),
    logoutAccount: async () => (
      (signedIn = false),
      { hasAccounts: true, remote: remotePolicy }
    ),
    revokeAllSessions: async () => (
      (signedIn = false),
      { hasAccounts: true, remote: remotePolicy }
    ),
    // Settings → Account: deletion uses this fixture's signed-in session,
    // just like SettingsAccountAPI.deleteAccount(), without a password.
    accountProfile: async () => ({
      kind: options.plan ? "remote" : "local",
      fullName,
      email: account.email ?? "",
      canDelete: !options.plan,
    }),
    // The offline preview has no paired relay devices. Do not let the
    // unsupported-method proxy masquerade as an invalid inventory response.
    listCoworkDevices: async () => [],
    activeSessions: async () => null,
    setFullName: async (name) => {
      fullName = name;
      return {
        kind: options.plan ? "remote" : "local",
        fullName,
        email: account.email ?? "",
        canDelete: !options.plan,
      };
    },
    deleteAccount: async () => {
      signedIn = false;
      return { hasAccounts: false };
    },
    snapshot: async () => {
      if (!firstSnapshotReady) {
        firstSnapshotWait ??= new Promise<void>((resolve) => {
          setTimeout(() => {
            firstSnapshotReady = true;
            resolve();
          }, snapshotDelay);
        });
        await firstSnapshotWait;
      }
      return structuredClone(state);
    },
    // The real bridge returns null for a service without a catalog.
    modelCatalog: async () => null,
    // Explicit empty synthetic backlog; preserve the real API's array shape.
    getTaskBacklog: async () => [],
    listCloudEnvironments: async () => {
      if (params.get("environments") === "error")
        throw new Error("Synthetic cloud environment lookup failure");
      return structuredClone(environments);
    },
    saveCloudEnvironment: async (input) => {
      if (!input.name.trim()) throw new Error("Enter an environment name");
      const value = {
        ...structuredClone(input),
        id: input.id ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
      environments = [
        ...environments.filter((row) => row.id !== value.id),
        value,
      ];
      return structuredClone(value);
    },
    archiveCloudEnvironment: async (id) => {
      environments = environments.filter((row) => row.id !== id);
    },
    saveSettings: async (settings) => {
      state.settings = structuredClone(settings);
      return structuredClone(settings);
    },
    usageSummary: async (range = "all") => ({
      range,
      total: {
        requests: 0,
        successful: 0,
        failed: 0,
        unmetered: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
      },
      models: [],
      daily: [],
      hours: [],
    }),
    updateConversation: async (id, patch) => {
      const c = find(id);
      if (patch.codePermissionMode !== undefined) {
        if (params.get("codePermissionSave") === "error")
          throw Error("Synthetic session permission save failure");
        if (c.mode !== "code")
          throw Error("Only Code sessions have a Code permission choice.");
        c.codePermissionMode = patch.codePermissionMode;
        c.codePermissionRevision = (c.codePermissionRevision ?? 0) + 1;
      }
      if (patch.title !== undefined) c.title = patch.title;
      if (patch.pinned !== undefined) c.pinned = patch.pinned;
      if (patch.archived !== undefined) c.archived = patch.archived;
      if (patch.projectId !== undefined)
        c.projectId = patch.projectId ?? undefined;
      if (patch.unread !== undefined)
        if (patch.unread) c.unread = true;
        else delete c.unread;
      return updated(c);
    },
    discardIncognito: async (id) => {
      state.conversations = state.conversations.filter(
        (c) => c.id !== id || !c.incognito,
      );
    },
    deleteConversation: async (id) => {
      state.conversations = state.conversations.filter((c) => c.id !== id);
    },
    reorderConversations: async () => structuredClone(state.conversations),
    // The page shows the side chat panel with a canned answer; the engine's
    // fork of the thread is not part of the fixture.
    askSideChat: async () => "This is a side answer from the fixture.",
    interruptSideChat: async () => {},
    endSideChat: async () => {},
    forkConversation: async (id, options) => {
      const c = find(id);
      const index = options?.turnId
        ? c.turns.findIndex((t) => t.id === options.turnId)
        : c.turns.length - 1;
      const target = c.turns[index];
      const forked: Conversation = {
        ...structuredClone(c),
        id: `${c.id}-fork-${(c.forks?.length ?? 0) + 1}`,
        turns: structuredClone(c.turns.slice(0, index + 1)),
        pinned: false,
        forks: undefined,
        forkedFrom: { conversationId: c.id, turnId: target.id, title: c.title },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      c.forks = [
        ...(c.forks ?? []),
        { conversationId: forked.id, turnId: target.id, createdAt: Date.now() },
      ];
      state.conversations.unshift(forked);
      updated(c);
      return updated(forked);
    },
    // The fixture has no agent to write the note: the new session starts
    // empty, linked both ways.
    handOffConversation: async (id) => {
      const c = find(id);
      const target = c.turns[c.turns.length - 1];
      const handed: Conversation = {
        ...structuredClone(c),
        id: `${c.id}-handoff-${(c.handOffs?.length ?? 0) + 1}`,
        turns: [],
        pinned: false,
        forks: undefined,
        forkedFrom: undefined,
        handOffs: undefined,
        handedOffFrom: {
          conversationId: c.id,
          turnId: target.id,
          title: c.title,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      c.handOffs = [
        ...(c.handOffs ?? []),
        {
          conversationId: handed.id,
          turnId: target.id,
          createdAt: Date.now(),
        },
      ];
      state.conversations.unshift(handed);
      updated(c);
      return updated(handed);
    },
    rewindConversation: async (id, turnId) => {
      const c = find(id);
      const index = turnId
        ? c.turns.findIndex((t) => t.id === turnId)
        : c.turns.length - 1;
      c.rewind = {
        variant: "pending",
        index,
        threadId: c.threadId,
        turns: c.turns.slice(index),
        at: Date.now(),
      };
      c.turns = c.turns.slice(0, index);
      return updated(c);
    },
    swapRewind: async (id) => {
      const c = find(id);
      const r = c.rewind!;
      const tail = c.turns.slice(r.index);
      c.turns = [...c.turns.slice(0, r.index), ...r.turns];
      c.rewind = {
        ...r,
        variant: r.variant === "pending" ? "forward" : "pending",
        turns: tail,
        at: Date.now(),
      };
      return updated(c);
    },
    retryResponse: async (id, turnId) => {
      const c = find(id);
      const t = c.turns.find((value) => value.id === turnId)!;
      Object.assign(t, {
        status: "completed",
        error: undefined,
        stopReason: undefined,
        items: [
          { id: `${turnId}-retry`, type: "agentMessage", text: "Retried." },
        ],
      });
      return updated(c);
    },
    loadRemoteImage: async () => fixtureRemoteImage,
    saveProject: async (project) => {
      state.projects = [
        ...state.projects.filter((p) => p.id !== project.id),
        project,
      ];
      return structuredClone(project);
    },
    listSchedules: async () => structuredClone(options.schedules ?? []),
    // Read the final domain implementation (not the pre-domain options):
    // fixture creates/edits and run receipts must be reflected on refresh.
    querySchedules: async () => {
      const source =
        state.host?.kind === "web" ? ("remote" as const) : ("local" as const);
      const tasks = await api.listSchedules!();
      return {
        tasks: await Promise.all(
          tasks.map(async (task) => {
            const runs = (await api.routineRuns?.(task.id)) ?? [];
            const ids = new Set(
              runs.flatMap((run) =>
                run.conversationId ? [run.conversationId] : [],
              ),
            );
            if (task.conversationId) ids.add(task.conversationId);
            for (const c of state.conversations)
              if (c.scheduledTaskId === task.id) ids.add(c.id);
            const unread = new Set(
              state.conversations
                .filter((c) => ids.has(c.id) && c.unread)
                .map((c) => c.id),
            );
            for (const run of runs)
              if (
                run.status === "completed" &&
                !run.readAt &&
                run.conversationId
              )
                unread.add(run.conversationId);
            const failedRuns = runs.filter(
              (run) => run.status === "failed" || run.status === "interrupted",
            );
            const failed = new Set(
              failedRuns.flatMap((run) =>
                run.conversationId ? [run.conversationId] : [],
              ),
            );
            for (const c of state.conversations)
              if (
                ids.has(c.id) &&
                ["failed", "interrupted"].includes(c.turns.at(-1)?.status ?? "")
              )
                failed.add(c.id);
            return {
              ...task,
              executionLocation: source,
              listMetadata: {
                source:
                  task.mode === "code" ? ("code" as const) : ("chat" as const),
                provenance: { backend: source },
                ...(source === "local" &&
                !task.environment &&
                params.get("taskDevices") === "some"
                  ? {
                      device: {
                        id: "fixture-computer-self",
                        name: "Fixture computer",
                        connectivity: "connected" as const,
                      },
                    }
                  : {}),
                host:
                  source === "remote"
                    ? ("cloud" as const)
                    : task.environment?.kind === "ssh"
                      ? ("ssh" as const)
                      : !task.environment || task.environment.kind === "local"
                        ? ("this-computer" as const)
                        : undefined,
                attention: {
                  unread:
                    unread.size +
                    runs.filter(
                      (run) =>
                        run.status === "completed" &&
                        !run.readAt &&
                        !run.conversationId,
                    ).length,
                  awaiting: state.approvals.filter((a) =>
                    ids.has(a.conversationId),
                  ).length,
                  failed:
                    failed.size +
                    failedRuns.filter((run) => !run.conversationId).length,
                  conversationIds: [...ids],
                },
              },
            };
          }),
        ),
        sources: [{ source, status: "ready" as const }],
      };
    },
    readSchedule: async (id) => {
      const task = (await api.querySchedules!()).tasks.find(
        (task) => task.id === id,
      );
      return task ? { status: "ready", task } : { status: "missing" };
    },
    listSkills: async () => [],
    listMcp: async () => [],
    // The background sleep keeps running until stopped from the panel.
    listBackgroundTerminals: async (conversationId) => ({
      conversationId,
      items:
        conversationId === "c-background" && !stoppedSleep
          ? [
              {
                conversationId,
                itemId: "cmd-sleep",
                processId: "bkrqhaoa8",
                command: "sleep 600",
                cwd: "/Users/fixture/claude-reference-edit-sandbox",
              },
            ]
          : [],
    }),
    stopBackgroundTerminal: async () => {
      stoppedSleep = true;
      return true;
    },
    // Sending starts a new running turn; nothing is sent anywhere.
    send: async (input) => {
      const c: Conversation = input.conversationId
        ? find(input.conversationId)
        : {
            id: `fixture-chat-${crypto.randomUUID()}`,
            title: input.text.slice(0, 50) || "Fixture chat",
            mode: input.mode,
            providerId: input.providerId,
            model: input.model,
            pinned: false,
            archived: false,
            projectId: input.projectId,
            cwd: input.cwd,
            turns: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...(input.scheduledTaskSetup
              ? {
                  scheduledTaskSetup: structuredClone(input.scheduledTaskSetup),
                }
              : {}),
          };
      if (!input.conversationId) state.conversations.unshift(c);
      c.turns.push({
        id: `t-sent-${c.turns.length}`,
        prompt: input.text,
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: Date.now(),
      });
      // Explicit synthetic completion; backend durability/ownership is tested separately.
      if (
        input.scheduledTaskSetup &&
        params.get("scheduledSetup") === "complete"
      ) {
        setTimeout(() => {
          void (async () => {
            const task = await api.saveSchedule!({
              name: "Fixture scheduled task",
              prompt: "Fixture task: summarize notes",
              mode: "cowork",
              providerId: input.providerId,
              model: input.model,
              frequency: "daily",
              repeat: { kind: "manual" },
              nextRunAt: Date.now() + 86400000,
              enabled: false,
              permission: "default",
              projectId: input.scheduledTaskSetup!.projectId,
              cwd: input.scheduledTaskSetup!.cwd,
            });
            c.scheduledTaskSetup = {
              ...input.scheduledTaskSetup!,
              createdTaskId: task.id,
            };
            const turn = c.turns.at(-1)!;
            turn.status = "completed";
            turn.items.push({
              id: `fixture-setup-${task.id}`,
              type: "agentMessage",
              text: `Fixture completion. [View task](/scheduled-task/${task.id}). This offline task is paused and never executes.`,
            });
            updated(c);
          })();
        }, 100);
      }
      // streamReply=1: a reply arrives in ~12-character deltas every 150ms,
      // the cadence recorded on claude.ai, so the streaming motion shows.
      if (params.get("streamReply")) {
        const turn = c.turns.at(-1)!;
        const reply =
          "## Interface sample\n\nThis paragraph arrives in small pieces, each fading in on its own while the reply rises into place. It has **bold** text, *italic* text and `inline code`.\n\n### Checklist\n\n- Headings and paragraphs\n- Lists and their spacing\n- The toolbar after the reply";
        const item: Item = {
          id: `m-${turn.id}`,
          type: "agentMessage",
          text: "",
          status: "inProgress",
        };
        let at = 0;
        const step = () => {
          if (at === 0) turn.items.push(item);
          at = Math.min(reply.length, at + 12);
          item.text = reply.slice(0, at);
          if (at >= reply.length) {
            turn.status = "completed";
            item.status = "completed";
          }
          updated(c);
          if (at < reply.length) setTimeout(step, 150);
        };
        setTimeout(step, 1200);
      }
      // connectionLost=1: the event stream drops while the reply runs
      // (Connection lost, Check now, the corner notice).
      if (params.get("connectionLost"))
        setTimeout(
          () => emit({ type: "stream-connection", connected: false }),
          800,
        );
      return updated(c);
    },
    approve: async (id, result) => {
      responses.push({ id, result });
      state.approvals = state.approvals.filter((a) => a.id !== id);
      emit({ type: "approval-resolved", id });
    },
    // No scheduled prompts or loops in the fixture sessions.
    listSessionLoops: async () => [],
    stopSessionLoop: async () => true,
    workingTreeChanges: async (
      conversationId,
      context,
    ): Promise<WorkingTreeChanges> =>
      conversationId === "c-changes" || conversationId === "c-approval"
        ? {
            state: "ready",
            base: "main",
            diff: workingTreeDiff(context),
            lineCounts: { "app.js": appLineCount, "utils.js": 3 },
            dirty: true,
            commits: [
              {
                sha: "4f1c2d9e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d",
                shortSha: "4f1c2d9",
                subject: "Greet with the trimmed name",
                author: "Ada",
                at: Date.now() - 2 * 3600_000,
              },
              {
                sha: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
                shortSha: "9a8b7c6",
                subject: "Add the doubling helper",
                author: "Ada",
                at: Date.now() - 3 * 86400_000,
              },
            ],
          }
        : { state: "ready", base: "main", diff: "", lineCounts: {} },
    terminalList: async (conversationId) =>
      structuredClone(terminals.get(conversationId) ?? []),
    terminalEnsure: async (conversationId) => {
      if (!terminals.get(conversationId)?.length) startTerminal(conversationId);
      return structuredClone(terminals.get(conversationId)!);
    },
    terminalStart: async (conversationId) =>
      structuredClone(startTerminal(conversationId)),
    // Echoes the keys, with a new prompt after Return.
    terminalWrite: async (conversationId, id, deltaBase64) => {
      const session = terminals
        .get(conversationId)
        ?.find((item) => item.id === id);
      if (!session?.running) return;
      const typed = fromBase64(deltaBase64);
      const echo = typed.replace(/\r/g, `\r\n${terminalPrompt(session.cwd)}`);
      session.outputBase64 = base64(fromBase64(session.outputBase64) + echo);
      session.sequence++;
      emit({
        type: "terminal-output",
        id,
        conversationId,
        deltaBase64: base64(echo),
        sequence: session.sequence,
      });
    },
    terminalResize: async () => {},
    terminalShells: async () => ({
      shells: [
        { id: "/bin/zsh", name: "zsh" },
        { id: "/bin/bash", name: "bash" },
      ],
      defaultId: "/bin/zsh",
    }),
    // The fixture's prompt runs nothing.
    terminalBusy: async () => [],
    terminalClose: async (conversationId, id) => {
      terminals.set(
        conversationId,
        (terminals.get(conversationId) ?? []).filter((item) => item.id !== id),
      );
    },
    chooseFolder: async () => null,
    chooseAttachments: async () => [],
    copyText: async () => {},
    appEnvironment: async () => ({
      version: "0.0.27",
      platform: "darwin",
      osVersion: "15.4.1",
      arch: "arm64",
      home: "/Users/fixture",
    }),
    installedEditors: async () => [
      { kind: "vscode", name: "VS Code", installed: true },
      { kind: "cursor", name: "Cursor", installed: true },
      { kind: "zed", name: "Zed", installed: false },
    ],
    openConversationInEditor: async () => true,
    githubCliStatus: async () => ({ installed: true, signedIn: true }),
    workspaceGit: async () => ({ branch: "main", githubRemote: true }),
    folderBranches: async () => ({
      current: "main",
      branches: ["main", "feature/rail", "fix/diff-colours"],
      defaultBranch: "main",
    }),
    folderChanges: async () => ({ files: 3, additions: 42, deletions: 7 }),
    switchFolderBranch: async () => ({ ok: false, reason: "dirty" }),
    resolveFolderChanges: async () => true,
    // Both transports retain the generated document's CSP and opaque frame
    // origin. data: also works in embedded browsers that cannot load blob:.
    createArtifactPreview: async (content) =>
      params.get("previewTransport") === "data"
        ? `data:text/html;charset=utf-8,${encodeURIComponent(content)}`
        : URL.createObjectURL(new Blob([content], { type: "text/html" })),
    releaseArtifactPreview: async (url) => URL.revokeObjectURL(url),
    readGeneratedFile: async (digest) => {
      const bytes = fixtureBlobs[digest];
      if (!bytes) throw Error("This file snapshot is no longer available.");
      return bytes;
    },
    windowAction: async () => {},
    onEvent: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  // ?threads=1: the Changes session opened a pull request with review threads.
  if (params.get("threads") === "1") {
    const changes = state.conversations.find((c) => c.id === "c-changes");
    const reply = changes?.turns[0]?.items.find(
      (item) => item.type === "agentMessage",
    );
    if (reply)
      reply.text +=
        "\n\n<pr-created>https://github.com/fixture/app/pull/7</pr-created>";
    changes?.turns[0]?.items.push({
      id: "review-fixture",
      type: "exitedReviewMode",
      review:
        'One issue.\n\nFull review comments:\n\n- [P2] Log the greeting for an empty name too — /Users/fixture/claude-reference-edit-sandbox/app.js:5-5\n  console.log only runs for "world", so the empty-name branch is never exercised.',
    });
    let resolved = false;
    Object.assign(api, {
      githubReviewThreads: async () => [
        {
          id: "PRRT_one",
          resolved: false,
          outdated: false,
          path: "app.js",
          line: 3,
          viewerCanReply: true,
          viewerCanResolve: true,
          comments: [
            {
              id: "C1",
              author: "reviewer",
              body: 'Keep the fallback in one place:\n```suggestion\n  return trimmed ? `Hello, ${trimmed}` : "Hello, friend";\n```',
              url: "https://github.com/fixture/app/pull/7#discussion_r1",
              diffHunk:
                '@@ -1,3 +1,4 @@\n export function greet(name) {\n-  return `Hello, ${name}`;\n+  const trimmed = (name ?? "").trim();\n+  return `Hello, ${trimmed || "friend"}`;',
            },
            {
              id: "C2",
              author: "ada",
              body: "Agreed, will change.",
              url: "https://github.com/fixture/app/pull/7#discussion_r2",
            },
          ],
        },
        {
          id: "PRRT_two",
          resolved: !resolved,
          outdated: false,
          path: "utils.js",
          line: 2,
          viewerCanReply: true,
          viewerCanResolve: true,
          comments: [
            {
              id: "C3",
              author: "reviewer",
              body: "Nice and small.",
              url: "https://github.com/fixture/app/pull/7#discussion_r3",
            },
          ],
        },
      ],
      githubResolveReviewThread: async () => {
        resolved = true;
      },
    });
  }
  // Each package's domain adds or replaces the calls it owns.
  for (const domain of Object.values(fixtureDomains))
    Object.assign(api, domain.bridge({ params, origin, state, emit }));
  // Opt in explicitly: these CLI sessions exist only in this fixture instance.
  Object.assign(api, nativeCliFixture({ params, origin, state, emit }));
  applyMenuAsyncFixture(api, params, state);
  // Anything the fixture does not model resolves to an empty result instead of throwing.
  return new Proxy(api as DesktopAPI, {
    get: (target, key: string) =>
      key in target ? target[key as keyof DesktopAPI] : async () => undefined,
  });
}

/** A chat with many ordinary turns (code blocks, lists, a table) for latency checks. */
function longConversation(count: number, origin: number): Conversation {
  const reply = (i: number) =>
    [
      `Here is step ${i + 1}. It explains the change and why it matters for the build.`,
      "",
      "- First, read the configuration.",
      "- Then, update the **cache key** and rerun the tests.",
      "",
      "```ts",
      `export function step${i}(input: string): string {`,
      "  return input.trim().toLowerCase();",
      "}",
      "```",
      "",
      "| File | Lines |",
      "| --- | --- |",
      `| src/step-${i}.ts | ${10 + i} |`,
    ].join("\n");
  return {
    id: "c-long",
    title: "Long conversation",
    mode: "chat",
    providerId: "fixture",
    model: "Opus 5.5",
    pinned: false,
    archived: false,
    cwd: "/tmp",
    createdAt: origin - count * 60_000,
    updatedAt: origin,
    turns: Array.from({ length: count }, (_, i) => ({
      id: `long-${i}`,
      prompt: `Question ${i + 1}: what should change next?`,
      attachments: [],
      items: [{ id: `long-${i}-m`, type: "agentMessage", text: reply(i) }],
      status: "completed",
      createdAt: origin - (count - i) * 60_000,
    })),
  } as unknown as Conversation;
}
