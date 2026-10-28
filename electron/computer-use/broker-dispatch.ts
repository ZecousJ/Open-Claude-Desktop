import type {
  ComputerUseToolResult,
  ControlCall,
} from "../../shared/computer-use";
import { appKey, neverGranted, onDeniedList } from "./app-tiers";
import type { DriverApp, DriverMode } from "./driver-host";
import {
  defaultMaxActionsPerTurn,
  text,
  failure,
  Refusal,
  actionTier,
  str,
} from "./broker-support";
import type { ComputerUseBroker } from "./broker";
import type { BrokerConversation, KnownApp, Grant } from "./broker";

export async function run(
  this: ComputerUseBroker,
  conversationId: string,
  call: ControlCall,
): Promise<ComputerUseToolResult> {
  try {
    const conversation = this.deps.conversation(conversationId);
    const refusal = this.refusalFor(conversation, { permissions: false });
    if (refusal) throw new Refusal(refusal);
    if (!conversation!.running)
      throw new Refusal(
        "Computer use only works while Claudex is working on a reply.",
      );
    if (!this.deps.permissionsReady()) {
      if (call.tool === "request_access")
        return await this.askPermissions(conversationId);
      throw new Refusal(
        "Claudex needs the macOS Accessibility and Screen Recording permissions. Call request_access to ask the person to grant them.",
      );
    }
    const turn = this.turn(conversationId, conversation!.turnId ?? call.turnId);
    if (turn.halted)
      throw new Refusal(
        "The person stopped computer use for this turn. Don't try again; tell them what's left to do.",
      );
    const cap = Math.min(
      this.deps.maxActionsPerTurn ?? defaultMaxActionsPerTurn,
      this.deps.policy().maxActionsPerTurn ?? Infinity,
    );
    if (call.tool !== "list_granted_applications" && ++turn.actions > cap)
      throw new Refusal(
        `This turn reached the limit of ${cap} computer-use actions. Stop and tell the person where you are.`,
      );
    if (this.control && this.control.conversationId !== conversationId)
      throw new Refusal(
        "Another conversation has full control of the screen right now. Try again later.",
      );
    if (
      this.teachingPending.has(conversationId) &&
      ![
        "list_apps",
        "list_granted_applications",
        "release_full_control",
        "end_teaching",
      ].includes(call.tool)
    )
      throw new Refusal("Wait for the person to choose Next or Exit.");
    return await this.dispatch(conversationId, conversation!, call);
  } catch (error) {
    if (error instanceof Refusal) return failure(error.message);
    return failure(
      error instanceof Error ? error.message : "Computer use failed.",
    );
  }
}

export function turn(
  this: ComputerUseBroker,
  conversationId: string,
  turnId: string | undefined,
) {
  let state = this.turns.get(conversationId);
  if (!state || state.turnId !== turnId) {
    state = { turnId, actions: 0, halted: false };
    this.turns.set(conversationId, state);
  }
  return state;
}

export function mode(
  this: ComputerUseBroker,
  conversationId: string,
): DriverMode {
  return this.control?.conversationId === conversationId
    ? "fullControl"
    : "background";
}

export async function dispatch(
  this: ComputerUseBroker,
  conversationId: string,
  conversation: BrokerConversation,
  call: ControlCall,
): Promise<ComputerUseToolResult> {
  const args = call.args;
  switch (call.tool) {
    case "teach_step": {
      if (this.control?.conversationId !== conversationId || !this.deps.teach)
        throw new Refusal("Request full control before teaching.");
      if (
        typeof args.explanation !== "string" ||
        args.explanation.length > 8000 ||
        typeof args.nextPreview !== "string" ||
        args.nextPreview.length > 2000
      )
        throw new Refusal("Teaching requires an explanation and nextPreview.");
      const anchor = args.anchorLogical as
        { x?: unknown; y?: unknown } | undefined;
      if (
        anchor !== undefined &&
        (!anchor ||
          typeof anchor.x !== "number" ||
          !Number.isFinite(anchor.x) ||
          typeof anchor.y !== "number" ||
          !Number.isFinite(anchor.y))
      )
        throw new Refusal("Teaching coordinates must be finite numbers.");
      if (this.teachingPending.has(conversationId))
        throw new Refusal("Wait for the person to choose Next or Exit.");
      this.teachingPending.add(conversationId);
      let answer: "next" | "exit";
      try {
        answer = await this.deps.teach.show({
          explanation: args.explanation,
          nextPreview: args.nextPreview,
          anchorLogical: anchor as { x: number; y: number } | undefined,
        });
      } finally {
        this.teachingPending.delete(conversationId);
      }
      if (answer === "exit") await this.stop(conversationId);
      return {
        content: [
          text(
            answer === "next"
              ? "Next: perform the explained step."
              : "The person exited teaching. Stop and do not perform the step.",
          ),
        ],
      };
    }
    case "end_teaching":
      if (this.control?.conversationId !== conversationId)
        throw new Refusal("This conversation is not teaching.");
      this.deps.teach?.hide();
      return { content: [text("Teaching finished.")] };
    case "list_apps":
      return this.listApps(conversationId);
    case "request_access":
      return this.requestAccess(conversationId, args);
    case "list_granted_applications":
      return this.listGranted(conversationId);
    case "request_full_control":
      return this.requestFullControl(conversationId, args);
    case "release_full_control":
      if (this.control?.conversationId !== conversationId)
        return { content: [text("You don't have full control.")] };
      await this.releaseControl();
      return { content: [text("Released full control of the screen.")] };
    case "read_clipboard":
    case "write_clipboard":
      return this.clipboard(conversationId, call.tool, args);
    default:
      if (!(call.tool in actionTier))
        throw new Refusal(`Unknown computer-use tool: ${call.tool}.`);
      return this.act(conversationId, conversation, call.tool, args);
  }
}

// -------------------------------------------------------------------------
// Apps.

export async function driverApps(
  this: ComputerUseBroker,
  conversationId: string,
  fresh = false,
) {
  const mode = this.mode(conversationId);
  if (
    !fresh &&
    this.appCache &&
    this.appCache.mode === mode &&
    this.now() - this.appCache.at < 5000
  )
    return this.appCache.apps;
  const apps = await this.exclusive(() => this.deps.driver.listApps(mode));
  this.appCache = { at: this.now(), apps, mode };
  return apps;
}

export function refOf(
  this: ComputerUseBroker,
  app: { id: string; name: string },
): KnownApp {
  return { id: app.id, name: app.name, platform: this.deps.platform };
}

/** Resolves a name or id the model gave to one app, running or installed. */
export async function resolve(
  this: ComputerUseBroker,
  conversationId: string,
  name: string,
): Promise<KnownApp | undefined> {
  const key = appKey(name);
  const running = await this.driverApps(conversationId).catch(
    () => [] as DriverApp[],
  );
  const installed = await this.deps.installedApps().catch(() => []);
  const byId =
    running.find((app) => appKey(app.id) === key) ??
    installed.find((app) => appKey(app.id) === key);
  const byName =
    byId ??
    running.find((app) => appKey(app.name) === key) ??
    installed.find((app) => appKey(app.name) === key);
  if (!byName) return undefined;
  const path = installed.find(
    (app) => appKey(app.id) === appKey(byName.id),
  )?.path;
  return { ...this.refOf(byName), ...(path ? { path } : {}) };
}

export function deniedBy(
  this: ComputerUseBroker,
  app: KnownApp,
): "never" | "denied" | undefined {
  if (neverGranted(app)) return "never";
  const settings = this.deps.settings();
  if (
    onDeniedList(app, this.deps.policy().deniedApps) ||
    settings.deniedApps.some((denied) => appKey(denied.id) === appKey(app.id))
  )
    return "denied";
  return undefined;
}

export function grantsOf(this: ComputerUseBroker, conversationId: string) {
  let grants = this.grants.get(conversationId);
  if (!grants) {
    grants = new Map();
    this.grants.set(conversationId, grants);
  }
  return grants;
}

/** The granted app a call names; refuses anything else. */
export async function granted(
  this: ComputerUseBroker,
  conversationId: string,
  name: unknown,
): Promise<Grant> {
  const given = str(name, "app", 300);
  const grants = this.grantsOf(conversationId);
  let grant = grants.get(appKey(given));
  if (!grant)
    for (const candidate of grants.values())
      if (appKey(candidate.app.name) === appKey(given)) grant = candidate;
  if (!grant)
    throw new Refusal(
      `${given} is not granted in this chat. Call request_access first.`,
    );
  // Lists may have changed since the grant.
  if (this.deniedBy(grant.app)) {
    grants.delete(appKey(grant.app.id));
    throw new Refusal(`${grant.app.name} is denied. Don't use it.`);
  }
  return grant;
}
