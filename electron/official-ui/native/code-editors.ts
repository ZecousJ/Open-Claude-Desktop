import path from "node:path";
import { z } from "zod";
import type { Conversation } from "../../../shared/types";
import type { AdapterContext } from "../api/context";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";
const kind = z.enum(["vscode", "cursor", "zed", "windsurf", "xcode"]);
const lineNumber = z.number().int().positive().max(1e7).optional();
type EditorCaller = { sessionId: string; current(): boolean };
function ownedCode(
  c: Conversation | undefined,
  owner: string,
  ssh = false,
): c is Conversation & { cwd: string } {
  return (
    !!c &&
    c.mode === "code" &&
    !c.cloudHosted &&
    !c.cloudEnvironmentId &&
    (ssh
      ? c.environment?.kind === "ssh"
      : (c.environment?.kind ?? "local") === "local") &&
    typeof c.cwd === "string" &&
    (ssh ? path.posix : path).isAbsolute(c.cwd) &&
    (!c.sessionAuthors ||
      (c.sessionAuthors.ownerAccountUuid === owner &&
        c.sessionAuthors.viewerAccountUuid === owner))
  );
}
const editors = z
  .array(
    z.object({
      kind,
      name: z.string().min(1).max(200),
      installed: z.boolean(),
      icon: z
        .string()
        .max(128 * 1024)
        .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
        .optional(),
    }),
  )
  .max(32);
export function createCodeEditors(
  ctx: AdapterContext,
  codeCaller: () => EditorCaller | undefined = () => undefined,
) {
  const scope = sessionAccountScope(ctx, () => {});
  const check = () => {
    scope.sync();
    if (!ctx.account()?.id || ctx.isCurrent?.() === false)
      throw Error("The editor account is no longer active.");
  };
  const call = async (name: string, ...args: unknown[]) => {
    check();
    if (!ctx.localCall) throw Error("Local editors are unavailable.");
    const value = await scope.guard(() => ctx.localCall!(name, ...args));
    check();
    return value;
  };
  return {
    list: (...args: unknown[]) =>
      scope.run(async () => {
        if (args.some((arg) => arg !== undefined))
          throw Error("Editor list arguments are unsupported.");
        const source = editors.parse(await call("installedEditors"));
        if (new Set(source.map((row) => row.kind)).size !== source.length)
          throw Error("The editor inventory is ambiguous.");
        return source.map((row) => ({
          type: row.kind,
          name: row.name,
          installed: row.installed,
          ...(row.icon ? { iconDataUrl: row.icon } : {}),
        }));
      }),
    open: (target: unknown, editor: unknown, ...options: unknown[]) =>
      scope.run(async () => {
        check();
        const caller = codeCaller();
        const current = () => {
          check();
          return !ctx.readOnly && (!caller || caller.current());
        };
        if (!current())
          throw Error("The Code editor window is no longer active.");
        const [remote, requestedLine, wsl, ...extra] = options;
        const ssh = remote != null;
        const paths = ssh ? path.posix : path;
        if (
          typeof target !== "string" ||
          !target ||
          target.length > 4096 ||
          target.includes("\0") ||
          !paths.isAbsolute(target) ||
          wsl != null ||
          extra.some((value) => value !== undefined)
        )
          throw Error("Choose an existing Code folder or file.");
        const selected = kind.parse(editor);
        const line = lineNumber.parse(requestedLine ?? undefined);
        const owner = ctx.account()!.id;
        if (!ctx.localLoadConversation)
          throw Error("Local Code sessions are unavailable.");
        const load = (id: string) =>
          scope.guard(() => ctx.localLoadConversation!(id));
        const matchingFolders = async () => {
          if (!ctx.localListConversations)
            throw Error("Local Code sessions are unavailable.");
          const rows = await scope.guard(() => ctx.localListConversations!());
          if (!Array.isArray(rows) || rows.length > 10000)
            throw Error("The Code session inventory is unavailable.");
          return rows.filter(
            (c) =>
              ownedCode(c, owner) &&
              path.normalize(c.cwd) === path.normalize(target),
          );
        };
        let session: Conversation;
        let sshTarget:
          | {
              hostId: string;
              sshHost: string;
              sshPort?: number;
              sshIdentityFile?: string;
            }
          | undefined;
        if (caller) {
          const active = await load(caller.sessionId);
          if (
            !current() ||
            !ownedCode(active, owner, ssh) ||
            active.id !== caller.sessionId
          )
            throw Error("The Code editor session is no longer available.");
          session = active;
          if (ssh) {
            const config = z
              .object({
                sshHost: z.string().min(1),
                sshPort: z.number().int().optional(),
                sshIdentityFile: z.string().optional(),
              })
              .parse(remote);
            const host = z
              .object({ kind: z.literal("ssh"), hostId: z.string() })
              .parse(await call("officialSshTarget", remote));
            if (
              active.environment?.kind !== "ssh" ||
              active.environment.hostId !== host.hostId
            )
              throw Error("The Code editor SSH connection changed.");
            sshTarget = { hostId: host.hostId, ...config };
          } else if (
            line === undefined &&
            path.normalize(active.cwd) !== path.normalize(target)
          ) {
            const matches = await matchingFolders();
            if (matches.length > 1)
              throw Error(
                "This folder does not identify one owned local Code session.",
              );
            session = matches[0] ?? active;
          }
        } else {
          if (ssh || line !== undefined)
            throw Error("Opening a file requires an active Code session.");
          const matches = await matchingFolders();
          if (matches.length !== 1)
            throw Error(
              "This folder does not identify one owned local Code session.",
            );
          session = matches[0];
        }
        const { id, cwd, createdAt } = session;
        const latest = await load(id);
        if (
          !current() ||
          !ownedCode(latest, owner, ssh) ||
          latest.id !== id ||
          latest.cwd !== cwd ||
          latest.createdAt !== createdAt ||
          (ssh &&
            (latest.environment?.kind !== "ssh" ||
              latest.environment.hostId !== sshTarget?.hostId))
        )
          throw Error("The Code session changed before opening its folder.");
        const result = caller
          ? await call("openConversationInEditor", id, selected, undefined, {
              target,
              line,
              current,
              ...(sshTarget ? { ssh: sshTarget } : {}),
            })
          : await call("openConversationInEditor", id, selected);
        if (typeof result !== "boolean")
          throw Error("The editor launch outcome is unavailable.");
        return result;
      }),
  };
}
export function registerCodeEditors(host: NativeHost) {
  const editors = createCodeEditors(host.ctx, () => {
    const window = host.caller;
    if (!window) return;
    const route = new URL(window.webContents.mainFrame.url).pathname;
    const sessionId = /^\/epitaxy\/local_([A-Za-z0-9-]+)\/?$/.exec(route)?.[1];
    if (!sessionId) return;
    const version = host.selectionVersion(window);
    return {
      sessionId,
      current: () =>
        !window.isDestroyed() &&
        host.selectionVersion(window) === version &&
        new URL(window.webContents.mainFrame.url).pathname === route,
    };
  });
  host.on("LocalSessions.getInstalledEditors", editors.list);
  host.on("LocalSessions.openInEditor", editors.open);
}
