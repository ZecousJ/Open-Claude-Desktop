/**
 * Folders added to a Cowork task (R11-D). The person adds a folder to a running
 * Cowork conversation (the Progress card's Context "+" or "Add folder" under
 * the composer); the access dialog records it as one of the task's added
 * folders (`electron/cowork-folders.ts`). This engine extension (S1's registry)
 * hands those folders to Codex:
 * - as extra writable roots of a workspace-write (Auto) turn, through
 *   turn/start `sandboxPolicy.writableRoots` (SP-3: the policy sticks to later
 *   turns and a narrower one takes roots away, so the engine sends the full
 *   list on every turn). Cowork turns run with full access, so the folders are
 *   named for the model only.
 * - as turn context naming the folders, once per thread and again whenever the
 *   list changes (developer instructions are fixed at thread/start).
 *
 * Every folder is checked again before each turn: a folder that no longer
 * exists, or that Cowork may no longer use, is left out. Paths are real paths,
 * so a symbolic link swapped after the grant doesn't widen anything. The model
 * can't add folders itself: only the person's click in the window reaches the
 * grant.
 */
import { onThisMachine, type Conversation } from "../../shared/types";
import type { AppContext } from "../app/app-context";
import type { CoworkFolderGrants } from "../workspace/cowork-folders";
import { preference } from "../../shared/settings-extras";
import type {
  EngineExtension,
  EngineTurnContext,
} from "../engine/engine-extensions";
import { readFolderInstructions } from "../engine/cowork-instructions";

export const coworkExtensionId = "cowork-folders";

/** What the extension reads from the account's folder grants. */
export type CoworkGrantsView = Pick<
  CoworkFolderGrants,
  "access" | "extraFolders"
> &
  Partial<Pick<CoworkFolderGrants, "executionBrowser">>;

export interface CoworkExtensionDeps {
  /** The signed-in account's folder grants, once loaded. */
  folders(): CoworkGrantsView | undefined;
}

/**
 * The task's added folders Cowork may still use, as real paths, in the
 * order they were added. Empty outside a local Cowork conversation.
 */
export function coworkAddedFolders(
  conversation: Readonly<Conversation>,
  mode: EngineTurnContext["mode"],
  grants: CoworkGrantsView | undefined,
  computerAccess = false,
): string[] {
  if (
    !grants ||
    mode !== conversation.mode ||
    !(mode === "cowork" || (mode === "chat" && computerAccess))
  )
    return [];
  if (!onThisMachine(conversation.environment)) return [];
  const folders: string[] = [];
  for (const folder of grants.extraFolders(conversation.id)) {
    // A remote path is checked again at the next actual turn, after any
    // symlink or session changes since the person granted it.
    if (conversation.environment?.kind === "space") {
      try {
        if (!grants.executionBrowser) continue;
        grants.executionBrowser(conversation).checked(folder);
      } catch {
        continue;
      }
    }
    const access = grants.access(folder, conversation.id);
    if (
      access.state !== "granted" &&
      access.state !== "trusted" &&
      !(
        conversation.environment?.kind === "space" && access.state === "default"
      )
    )
      continue;
    if (!folders.includes(access.folder)) folders.push(access.folder);
  }
  return folders;
}

/** The turn context that names the task's added folders. */
export function addedFoldersContext(
  folders: readonly string[],
  sandbox: EngineTurnContext["sandbox"],
): string {
  if (!folders.length)
    return "The person's added folders are no longer available to this task. Work only in the working folder.";
  return [
    "Besides the working folder, the person added these folders to this task:",
    ...folders.map((folder) => `- ${folder}`),
    sandbox !== "read-only"
      ? "You may read and change files in them as you would in the working folder."
      : "You may read files in them; changes need the person's approval, as in the working folder.",
    "Don't use other folders on this computer.",
  ].join("\n");
}

/** The engine extension; keeps which thread was told about which folders. */
export function coworkExtension(
  deps: CoworkExtensionDeps,
): EngineExtension & { forget(conversationId: string): void } {
  /** Conversation → what its thread was last told. */
  const told = new Map<
    string,
    { thread: string; key: string; folders: number; turn: number }
  >();
  const added = (ctx: EngineTurnContext) =>
    coworkAddedFolders(
      ctx.conversation,
      ctx.mode,
      deps.folders(),
      preference(ctx.settings, "computerAccess"),
    );
  // The folder's CLAUDE.md as last told to each conversation: told again
  // only when it changed (or was emptied), not on every turn.
  const instructed = new Map<string, string>();
  return {
    id: coworkExtensionId,
    // An incognito task's folders count too (its grants stay in memory).
    incognito: true,
    turnSandboxExtras: added,
    turnContext(ctx) {
      const instructions: Record<string, string> = {};
      if (
        ctx.mode === "cowork" &&
        ctx.conversation.cwd &&
        onThisMachine(ctx.conversation.environment)
      ) {
        try {
          const content = readFolderInstructions(ctx.conversation.cwd);
          const last = instructed.get(ctx.conversation.id);
          if (content !== (last ?? "")) {
            instructions["folder-instructions"] =
              `Folder instructions (CLAUDE.md):\n${content}`;
            instructed.set(ctx.conversation.id, content);
          }
        } catch {}
      }
      const folders = folderContext(ctx);
      return Object.keys(instructions).length
        ? { ...instructions, ...folders }
        : folders;
    },
    forget(conversationId) {
      told.delete(conversationId);
      instructed.delete(conversationId);
    },
  };
  function folderContext(ctx: EngineTurnContext) {
    const thread = ctx.conversation.threadId;
    // The engine starts the thread before it asks for the turn's context.
    if (!thread) return undefined;
    const folders = added(ctx);
    const key = [ctx.sandbox, ...folders].join("\n");
    const turns = ctx.conversation.turns;
    let before = told.get(ctx.conversation.id);
    // The turn that carried the context never started (turn/start failed
    // before Codex gave it an ID): the thread wasn't told after all.
    const carrier = before ? turns[before.turn] : undefined;
    if (
      carrier &&
      carrier.status === "failed" &&
      carrier.id.startsWith("pending-")
    )
      before = undefined;
    const last = before?.thread === thread ? before : undefined;
    if (last?.key === key) return undefined;
    // No folders: only a thread that was told about some hears they went.
    if (!folders.length && !last?.folders) return undefined;
    told.set(ctx.conversation.id, {
      thread,
      key,
      folders: folders.length,
      // The engine adds the turn before it asks for the turn's context.
      turn: turns.length - 1,
    });
    return { folders: addedFoldersContext(folders, ctx.sandbox) };
  }
}

/**
 * Adds the extension to each signed-in account's local engine (SSH hosts'
 * engines never run Cowork this round) and removes it when the account goes.
 */
export function registerCoworkExtension(
  ctx: Pick<
    AppContext,
    "engine" | "services" | "onAccountActivated" | "onAccountDeactivating"
  >,
) {
  let cleanup: (() => void) | undefined;
  // Test contexts may leave out the account hooks.
  ctx.onAccountActivated?.(() => {
    cleanup?.();
    const engine = ctx.engine;
    const extension = engine.extensions.has(coworkExtensionId)
      ? undefined
      : coworkExtension({ folders: () => ctx.services.coworkFolders });
    const remove = extension ? engine.extensions.add(extension) : undefined;
    // Isolated execution spaces run on peer engines. They must receive the
    // same grant checker/context contribution as the account's native engine.
    if (extension) engine.peerExtensions?.push(extension);
    cleanup = () => {
      remove?.();
      if (extension && engine.peerExtensions)
        engine.peerExtensions = engine.peerExtensions.filter(
          (entry) => entry !== extension,
        );
      cleanup = undefined;
    };
  });
  ctx.onAccountDeactivating?.(() => cleanup?.());
}
