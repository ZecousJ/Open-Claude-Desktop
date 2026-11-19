import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AppContext } from "../app/app-context";
import {
  type EngineExtension,
  type DynamicToolResult,
} from "../engine/engine-extensions";
import { inAdapterScope, newAdapterScope } from "../official-ui/api/scope";
import { readState } from "../official-ui/api/state";
import {
  installedEditors,
  openFileInEditor,
  type EditorFileLaunch,
} from "./editors";
import { sshEditorWorkspace, type EditorSshWorkspace } from "./editor-ssh-file";
import {
  checkedFilePath,
  identifyLocalFile,
  sessionRoots,
} from "./editor-path";
import type { Conversation, EnvironmentRef } from "../../shared/types";
import {
  editorApprovalServerName,
  editorUrl,
  menuEditors,
  type EditorInfo,
} from "../../shared/editors";

const kinds = ["vscode", "cursor", "windsurf", "zed"] as const;
type Kind = (typeof kinds)[number];
const argsSchema = z
  .object({
    path: z.string().min(1).max(4096),
    line: z.number().int().positive().max(1e7).optional(),
    column: z.number().int().positive().max(1e7).optional(),
    editor: z.enum(kinds).optional(),
  })
  .strict();
const result = (success: boolean, text: string): DynamicToolResult => ({
  success,
  contentItems: [{ type: "inputText", text }],
});

type SshEnvironment = Extract<EnvironmentRef, { kind: "ssh" }>;
type EditorSession = Conversation & {
  cwd: string;
  environment?: Extract<EnvironmentRef, { kind: "local" | "ssh" }>;
};

export interface EditorToolDeps {
  owner(): string | undefined;
  current(): boolean;
  conversation(id: string): Conversation | undefined;
  preferred(): unknown;
  authorizeRoot(root: string, environment?: EnvironmentRef): void;
  sshWorkspace?(
    session: EditorSession,
    environment: SshEnvironment,
  ): EditorSshWorkspace | undefined;
  inventory(): Promise<EditorInfo[]>;
  approve(
    id: string,
    file: string,
    threadId: string,
    turnId: string,
  ): Promise<boolean>;
  open(
    kind: Kind,
    file: string,
    line?: number,
    column?: number,
    options?: EditorFileLaunch,
  ): Promise<boolean>;
}
function eligible(
  c: Conversation | undefined,
  owner: string | undefined,
): c is EditorSession {
  return (
    !!owner &&
    !!c &&
    c.mode === "code" &&
    !c.archived &&
    !c.incognito &&
    !c.cloudHosted &&
    !c.cloudEnvironmentId &&
    (!c.environment ||
      c.environment.kind === "local" ||
      c.environment.kind === "ssh") &&
    !c.linkedToComputer &&
    !c.chatDeviceBinding &&
    !c.remoteCodeWorktree &&
    !c.remoteControlStarted &&
    c.worktree?.state !== "deleted" &&
    (!c.sessionAuthors ||
      (c.sessionAuthors.ownerAccountUuid === owner &&
        c.sessionAuthors.viewerAccountUuid === owner)) &&
    !!c.cwd &&
    (c.environment?.kind === "ssh" ? path.posix : path).isAbsolute(c.cwd)
  );
}

export function editorToolExtension(deps: EditorToolDeps): EngineExtension {
  return {
    id: "code-editor-tool",
    dynamicTools: (ctx) =>
      ctx.mode === "code" &&
      eligible(ctx.conversation, deps.owner()) &&
      deps.current() &&
      (ctx.conversation.environment?.kind !== "ssh" || deps.sshWorkspace)
        ? [
            {
              type: "function",
              name: "open_file_in_editor",
              description:
                "Open a file from this Code session in the user's editor after approval. Omit editor to use their preference. SSH supports VS Code, Cursor, and Windsurf.",
              inputSchema: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  line: { type: "integer", minimum: 1 },
                  column: { type: "integer", minimum: 1 },
                  editor: { type: "string", enum: kinds },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
          ]
        : undefined,
    async handleDynamicTool(call) {
      if (call.namespace || call.tool !== "open_file_in_editor")
        return undefined;
      const parsed = argsSchema.safeParse(call.arguments);
      if (!parsed.success) return result(false, "Invalid editor arguments.");
      const owner = deps.owner();
      const c = deps.conversation(call.conversation.id);
      const turn = c?.turns.at(-1);
      if (
        !deps.current() ||
        !eligible(c, owner) ||
        c !== call.conversation ||
        c.threadId !== call.threadId ||
        turn?.id !== call.turnId ||
        turn.status !== "inProgress" ||
        (call.turn !== undefined && call.turn !== turn)
      )
        return result(false, "This Code session is unavailable.");
      const { cwd, createdAt } = c;
      const environment = structuredClone(c.environment);
      const roots = sessionRoots(c);
      const grants = [...(c.codeSessionFolderGrants ?? [])];
      const ssh =
        environment?.kind === "ssh"
          ? deps.sshWorkspace?.(c, environment)
          : undefined;
      if (environment?.kind === "ssh" && !ssh)
        return result(
          false,
          "This Code session's SSH connection is unavailable.",
        );
      const current = () =>
        deps.current() &&
        deps.owner() === owner &&
        deps.conversation(c.id) === c &&
        eligible(c, owner) &&
        c.threadId === call.threadId &&
        c.turns.at(-1) === turn &&
        turn.id === call.turnId &&
        turn.status === "inProgress" &&
        !turn.userStopped &&
        c.cwd === cwd &&
        c.createdAt === createdAt &&
        isDeepStrictEqual(c.environment, environment) &&
        isDeepStrictEqual(sessionRoots(c), roots) &&
        isDeepStrictEqual(c.codeSessionFolderGrants ?? [], grants) &&
        (!ssh || ssh.current());
      try {
        const { file, root } = checkedFilePath(
          cwd,
          parsed.data.path,
          roots,
          ssh ? path.posix : path,
        );
        const authorize = () => {
          if (!current()) throw Error("The Code session changed.");
          if (
            !(grants.includes(root) && c.additionalFolders?.includes(root)) ||
            root === cwd
          )
            deps.authorizeRoot(root, environment);
        };
        const identify = ssh?.identify ?? identifyLocalFile;
        authorize();
        const before = await identify(root, file);
        if (ssh) {
          if (before.real !== file)
            throw Error("Symbolic links cannot be opened.");
          editorUrl("vscode://", before.real, ssh.target);
        }
        const available = menuEditors(await deps.inventory(), !!ssh).filter(
          (editor): editor is EditorInfo & { kind: Kind } =>
            editor.kind !== "xcode",
        );
        authorize();
        const preferred = deps.preferred();
        const selected = parsed.data.editor
          ? available.find((e) => e.kind === parsed.data.editor)
          : (available.find((e) => e.kind === preferred) ??
            (available.length === 1 ? available[0] : undefined));
        if (!selected)
          return result(
            false,
            parsed.data.editor
              ? `The requested editor is unavailable. Available: ${available.map((e) => e.name).join(", ") || "none"}.`
              : available.length
                ? `Ask the user which editor to use: ${available.map((e) => `${e.name} (${e.kind})`).join(", ")}.`
                : "No supported editor is installed.",
          );
        if (
          !(await deps.approve(
            c.id,
            ssh
              ? `${ssh.target.destination}${ssh.target.port ? `:${ssh.target.port}` : ""}\n${before.real}`
              : file,
            call.threadId,
            call.turnId,
          ))
        )
          return result(false, "Opening the file was not approved.");
        authorize();
        const after = await identify(root, file);
        authorize();
        if (!isDeepStrictEqual(before, after))
          return result(false, "The file changed before opening.");
        const target = ssh ? after.real : file;
        if (
          !(await deps.open(
            selected.kind,
            target,
            parsed.data.line,
            parsed.data.line ? parsed.data.column : undefined,
            {
              ssh: ssh?.target,
              current: () => {
                authorize();
                return true;
              },
            },
          ))
        )
          return result(false, "The editor did not accept the file.");
        return result(true, `Opened ${target} in ${selected.name}.`);
      } catch {
        return result(
          false,
          "The file could not be safely opened. Tell the user its path instead.",
        );
      }
    },
  };
}

export function registerCodeEditorTools(ctx: AppContext) {
  let remove: (() => void) | undefined;
  ctx.onAccountActivated((account) => {
    remove?.();
    const identity = ctx.accountActivationIdentity;
    const store = ctx.store;
    const engine = ctx.engine;
    const current = () =>
      !ctx.accountRetiring &&
      ctx.accountActivationIdentity === identity &&
      ctx.store === store &&
      ctx.engine === engine &&
      ctx.activeAccount?.id === account.id;
    const extension = editorToolExtension({
      owner: () => ctx.activeAccount?.id,
      current,
      conversation: (id) => store.conversations.find((c) => c.id === id),
      preferred: () =>
        inAdapterScope(
          newAdapterScope(account.id, store.root, identity),
          () => {
            const prefs = readState<Record<string, unknown>>("preferences", {});
            const epitaxy = prefs.epitaxyPrefs;
            return epitaxy && typeof epitaxy === "object"
              ? (epitaxy as Record<string, unknown>)[
                  "claude-code-preferred-editor"
                ]
              : undefined;
          },
        ),
      authorizeRoot: (root, environment) =>
        ctx.allowedFolder(root, environment),
      sshWorkspace: (session, environment) =>
        sshEditorWorkspace(ctx, session, environment),
      inventory: () => installedEditors(),
      approve: async (id, file, threadId, turnId) =>
        (
          await engine.requestAppApproval(id, {
            threadId,
            turnId,
            serverName: editorApprovalServerName,
            mode: "form",
            message: `Allow opening this file in your editor?\n${file}`,
            requestedSchema: {
              type: "object",
              properties: {
                decision: {
                  type: "string",
                  enum: ["once"],
                  enumNames: ["Allow"],
                },
              },
              required: ["decision"],
            },
          })
        )?.action === "accept",
      open: openFileInEditor,
    });
    const installed = ctx.engines
      .all()
      .filter((peer) => peer === engine || peer.environment.kind === "ssh")
      .map((peer) => peer.extensions.add(extension));
    engine.peerExtensions.push(extension);
    remove = () => {
      for (const dispose of installed) dispose();
      engine.peerExtensions = engine.peerExtensions.filter(
        (entry) => entry !== extension,
      );
    };
  });
  ctx.onAccountDeactivating(() => {
    remove?.();
    remove = undefined;
  });
}
