import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { profileReadLease } from "../account/profile-read-lease";
import {
  SessionTransfer,
  type TransferProgress,
} from "../conversations/session-transfer";
import path from "node:path";
import { storeAttachment } from "../engine/composer-files";
import { beginCodeSessionLifecycle } from "../conversations/code-lifecycle-guard";

const cutoff = z.number().finite().min(0);
const identifier = z.string().min(1).max(200);
const operations = z.enum([
  "preview",
  "export",
  "cancelExport",
  "showExport",
  "share",
  "pickZips",
  "peek",
  "registerBundle",
  "pickFolder",
  "enumerate",
  "scan",
  "import",
  "confirm",
  "history",
  "removePreview",
  "remove",
]);
export function registerSessionTransferHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const capture = profileReadLease(ctx);
  let active: { identity: unknown; transfer: SessionTransfer } | undefined;
  let selections = new WeakMap<object, Set<string>>();
  ctx.onAccountDeactivating(() => {
    active?.transfer.dispose();
    active = undefined;
    selections = new WeakMap();
  });
  handle(
    "officialSessionTransfer",
    async (rawOperation: unknown, rawArgs: unknown, rawProgress?: unknown) => {
      const operation = operations.parse(rawOperation),
        args = z.array(z.unknown()).parse(rawArgs);
      const lease = capture(),
        identity = ctx.accountActivationIdentity;
      const assertCurrent = () => {
        if (!lease.current())
          throw Error("The account changed during session transfer.");
      };
      assertCurrent();
      const store = lease.store;
      if (!active || active.identity !== identity) {
        active?.transfer.dispose();
        active = {
          identity,
          transfer: new SessionTransfer({
            root: store.root,
            accountId: lease.accountId!,
            appVersion: ctx.appVersion,
            conversations: () => store.conversations,
            projects: () => store.projects,
            assertCurrent,
            provider: () => {
              const provider = store.settings.providers.find(
                (p) => p.id === store.settings.activeProviderId,
              );
              if (!provider)
                throw Error("A provider is required to import sessions.");
              return provider;
            },
            storeImage: (name, data) =>
              storeAttachment(
                path.join(store.root, "attachments"),
                name,
                data,
                ctx.policy(),
              ),
            importConversations: (additions, projects) => {
              store.commitImportedConversations(
                additions,
                lease.current,
                projects,
              );
              ctx.push({ type: "resync" });
            },
            saveConversation: async (conversation) => {
              const original = store.conversations.find(
                (c) => c.id === conversation.id,
              );
              if (!original) throw Error("Session not found");
              await store.persistChatMetadata(
                original,
                {
                  importedSessionResumePending:
                    conversation.importedSessionResumePending,
                },
                lease.current,
              );
              ctx.push({ type: "conversation", conversation });
            },
            removeConversations: async (ids, projectIds) => {
              const targets = store.conversations.filter((c) => ids.has(c.id));
              if (
                targets.some((c) =>
                  c.turns.some((t) => t.status === "inProgress"),
                )
              )
                throw Error("A session is still running.");
              const releases: (() => void)[] = [];
              try {
                for (const conversation of targets)
                  releases.push(beginCodeSessionLifecycle(conversation));
                for (const conversation of targets) {
                  assertCurrent();
                  await ctx.terminals?.closeConversation(conversation.id);
                  assertCurrent();
                  store.commitLocalCodeLifecycle(
                    conversation,
                    null,
                    lease.current,
                  );
                  ctx.replyFeedback.deleteConversation(conversation.id);
                }
              } finally {
                for (const release of releases) release();
              }
              for (const id of projectIds) {
                if (
                  store.conversations.some(
                    (conversation) => conversation.projectId === id,
                  )
                )
                  continue;
                const project = store.projects.find(
                  (project) => project.id === id,
                );
                if (project)
                  await store.deleteProjectWithChats(project, lease.current);
              }
              ctx.push({ type: "resync" });
            },
          }),
        };
      }
      const transfer = active.transfer;
      const progress: TransferProgress =
        typeof rawProgress === "function"
          ? (kind, phase, done, total) => {
              assertCurrent();
              rawProgress(kind, phase, done, total);
            }
          : () => {};
      const window = ctx.callerWindow();
      const picked = () => {
        if (!window) throw Error("Open session transfer in an account window.");
        let selection = selections.get(window);
        if (!selection) {
          selection = new Set();
          selections.set(window, selection);
        }
        return selection;
      };
      const pickedPath = (value: unknown) => {
        const file = z.string().min(1).parse(value);
        if (!picked().has(file)) throw Error("ZIP_UNREADABLE");
        return file;
      };
      switch (operation) {
        case "preview":
          return transfer.preview(cutoff.parse(args[0]));
        case "export": {
          const { app } = await import("electron");
          return transfer.export(
            cutoff.parse(args[0]),
            app.getPath("downloads"),
            progress,
          );
        }
        case "cancelExport":
          return transfer.cancelExport();
        case "showExport": {
          const file = z.string().parse(args[0]);
          if (!transfer.ownsExport(file)) return;
          const { shell } = await import("electron");
          assertCurrent();
          shell.showItemInFolder(file);
          return;
        }
        case "share": {
          const { app } = await import("electron");
          return transfer.share(
            identifier.parse(args[0]),
            app.getPath("downloads"),
          );
        }
        case "pickZips": {
          const { dialog } = await import("electron");
          if (!window)
            throw Error("Open session transfer in an account window.");
          const result = await dialog.showOpenDialog(window, {
            title: "Choose your export",
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "Zip archive", extensions: ["zip"] }],
          });
          assertCurrent();
          const paths = result.canceled ? [] : result.filePaths;
          for (const file of paths) picked().add(file);
          return paths;
        }
        case "peek": {
          const files = z
            .array(z.string())
            .min(1)
            .parse(args[0])
            .map(pickedPath);
          if (files.length > 1) return { ok: false, errorCode: "MIXED_KINDS" };
          return transfer.peek(files[0]);
        }
        case "registerBundle":
          return transfer.add(pickedPath(args[0]));
        case "pickFolder": {
          const { dialog } = await import("electron");
          if (!window)
            throw Error("Open session transfer in an account window.");
          const result = await dialog.showOpenDialog(window, {
            title: "Choose a Claude data folder",
            properties: process.platform === "win32" ? ["openDirectory"] : ["openDirectory", "openFile"],
            filters: [{ name: "Zip or folder", extensions: ["zip"] }],
          });
          assertCurrent();
          const file = result.canceled ? undefined : result.filePaths[0];
          if (!file) return {};
          picked().add(file);
          return transfer.add(file);
        }
        case "enumerate":
          return transfer.enumerate();
        case "scan":
          return transfer.scan(identifier.parse(args[0]));
        case "import":
          return transfer.run(
            cutoff.parse(args[0]),
            z.array(identifier).max(50).parse(args[1]),
            progress,
          );
        case "confirm":
          return transfer.confirm(identifier.parse(args[0]));
        case "history":
          return transfer.history();
        case "removePreview":
          return transfer.removePreview(identifier.parse(args[0]));
        case "remove":
          return transfer.remove(identifier.parse(args[0]));
      }
    },
  );
}
