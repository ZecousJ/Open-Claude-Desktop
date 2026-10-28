/**
 * Cowork folder access (R11) for the preview. The fixture keeps grants the
 * way the main process does (electron/cowork-folders.ts), in memory: its own
 * workspace needs no permission, trusted folders cover the folders inside
 * them, Allow lets one new task (or the given task) use a folder, and
 * Always allow trusts it. Every other folder asks with the access dialog.
 *
 * `cowork-access` makes the folder picker (Add folder) return a folder, so a
 * preview can open the dialog from the Cowork home's folder menu:
 *   ask     "claude-reference-cowork-sandbox"
 *   home    the home folder (the dialog warns)
 *   refused the file system root (refused with a reason, no dialog)
 *   trusted a folder inside a trusted folder (no dialog)
 */
import type { CoworkFolderAccess } from "../../../shared/cowork-api";
import type { FixtureDomain } from "./index";

const home = "/Users/fixture";
const workspace = `${home}/Library/Application Support/Claudex/workspace`;
const picked: Record<string, string> = {
  ask: `${home}/Documents/claude-reference-cowork-sandbox`,
  home,
  refused: "/",
  trusted: `${home}/Projects/reports/2026`,
};

const inside = (folder: string, parent: string) =>
  folder === parent || folder.startsWith(parent.replace(/\/$/, "") + "/");
const name = (folder: string) =>
  folder.split("/").filter(Boolean).pop() ?? folder;

export const coworkFolderAccessFixture: FixtureDomain = {
  params: {
    taskFolders: "execution: explicit synthetic execution-host folder browser",
    "cowork-access":
      "ask | home | refused | trusted: the folder the picker returns",
  },
  bridge: ({ params, state, emit }) => {
    const variant = params.get("cowork-access");
    const trusted = new Set<string>(
      variant === "trusted" ? [`${home}/Projects/reports`] : [],
    );
    const once = new Set<string>();
    const sessions = new Map<string, { primary?: string; extra: string[] }>();
    const coworkConversation = (id: string) => {
      const found = state.conversations.find((c) => c.id === id);
      if (!found || (found.mode !== "cowork" && found.mode !== "chat"))
        throw new Error("Cowork conversation not found.");
      return found;
    };
    const access = (
      folder: string,
      conversationId?: string,
    ): CoworkFolderAccess => {
      const described = {
        folder,
        name: name(folder),
        ...(folder === home ? { home: true } : {}),
      };
      if (inside(folder, workspace)) return { state: "default", ...described };
      if (folder === "/" || /^\/(System|usr|bin|etc)(\/|$)/.test(folder))
        return {
          state: "refused",
          ...described,
          reason:
            "Cowork can't use a system folder. Choose a folder inside it.",
        };
      const by = [...trusted].find((parent) => inside(folder, parent));
      if (by) return { state: "trusted", ...described };
      const session = conversationId ? sessions.get(conversationId) : undefined;
      if (
        once.has(folder) ||
        session?.primary === folder ||
        session?.extra.includes(folder)
      )
        return { state: "granted", ...described };
      return { state: "ask", ...described };
    };
    const changed = (conversationId?: string) =>
      emit({
        type: "cowork-folders",
        ...(conversationId ? { conversationId } : {}),
      });
    return {
      ...(variant && picked[variant]
        ? { chooseFolder: async () => picked[variant] }
        : {}),
      coworkFolderAccess: async (folder, conversationId) => {
        if (conversationId) coworkConversation(conversationId);
        return access(folder, conversationId);
      },
      grantCoworkFolder: async (folder, scope, target) => {
        const current = access(folder, target?.conversationId);
        if (current.state === "refused") throw new Error(current.reason);
        if (current.state === "default") return current;
        if (scope === "always") trusted.add(folder);
        if (target?.conversationId) {
          const conversation = coworkConversation(target.conversationId);
          const session = sessions.get(conversation.id) ?? { extra: [] };
          if (conversation.cwd === folder) session.primary = folder;
          else if (!session.extra.includes(folder)) session.extra.push(folder);
          sessions.set(conversation.id, session);
        } else if (scope === "session") once.add(folder);
        changed(target?.conversationId);
        return access(folder, target?.conversationId);
      },
      coworkFolders: async (id) => {
        const found = coworkConversation(id);
        return {
          ...(found.cwd ? { primary: found.cwd } : {}),
          extra: sessions.get(id)?.extra ?? [],
          ...(params.get("taskFolders") === "execution"
            ? {
                browser: {
                  kind: "execution" as const,
                  root: "/workspace",
                  initialPath: "/workspace",
                },
              }
            : state.host?.capabilities.localFolders &&
                state.settings.computerAccess !== false
              ? { browser: { kind: "native" as const } }
              : {}),
        };
      },
      listTaskFolderDirectory: async (id: string, folder: string) => {
        coworkConversation(id);
        folder = folder.replace(/\/+$/, "") || "/";
        if (params.get("taskFolders") !== "execution")
          throw Error("Folder access is unavailable for this session.");
        const directories: Record<string, string[]> = {
          "/workspace": ["notes", "reports"],
          "/workspace/notes": ["drafts"],
          "/workspace/notes/drafts": [],
          "/workspace/reports": [],
        };
        if (!Object.hasOwn(directories, folder))
          throw Error(
            "Couldn’t open that folder. Check the path and try again.",
          );
        return {
          path: folder,
          ...(folder !== "/workspace"
            ? { parent: folder.slice(0, folder.lastIndexOf("/")) }
            : {}),
          directories: directories[folder],
        };
      },
      trustedCoworkFolders: async () => [...trusted].sort(),
      addTrustedCoworkFolder: async () => {
        trusted.add(picked.ask);
        changed();
        return [...trusted].sort();
      },
      removeTrustedCoworkFolder: async (folder) => {
        trusted.delete(folder);
        changed();
        return [...trusted].sort();
      },
      // The preview has no file manager; the call succeeds like the real one.
      revealCoworkFolder: async (id, folder) => {
        const found = coworkConversation(id);
        if (found.cwd !== folder && !sessions.get(id)?.extra.includes(folder))
          throw new Error("This folder isn't part of this task.");
      },
    };
  },
};
