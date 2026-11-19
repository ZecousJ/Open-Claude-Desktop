import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Conversation } from "../../shared/types";
import { beginCodeSessionLifecycle } from "../conversations/code-lifecycle-guard";
import {
  carryScratchFiles,
  departingScratch,
} from "../workspace/carry-scratch-files";
import { realFolder } from "../workspace/workspace-trust";

type FolderChangeLease = {
  expected: Pick<Conversation, "cwd" | "createdAt">;
  current: () => boolean;
};

type SessionFolderContext = Pick<
  AppContext,
  "store" | "engine" | "selectedFolders" | "allowedFolder" | "services"
> &
  Partial<
    Pick<
      AppContext,
      | "activeAccount"
      | "accountRetiring"
      | "onAccountActivated"
      | "onAccountDeactivating"
      | "push"
    >
  > & {
    terminals?: Pick<NonNullable<AppContext["terminals"]>, "closeConversation">;
  };

export function registerOfficialSessionFolder(
  handle: IpcHandle,
  ctx: SessionFolderContext,
) {
  let activation = 0;
  ctx.onAccountActivated?.(() => {
    activation++;
  });
  ctx.onAccountDeactivating?.(() => {
    activation++;
  });
  handle(
    "officialChangeSessionFolder",
    async (rawId: unknown, rawCwd: unknown, lease?: FolderChangeLease) => {
      const id = z.string().min(1).max(200).parse(rawId);
      const cwd = z
        .string()
        .min(1)
        .max(4096)
        .refine(path.isAbsolute)
        .parse(rawCwd);
      if (
        process.platform === "win32" &&
        /^(?:[\\/]{2}|[\\/]\?\?[\\/])/.test(cwd)
      )
        throw Error(
          "Network (UNC) paths can't be used as a session working directory.",
        );
      const started = activation;
      const { store, engine } = ctx;
      const owner = ctx.activeAccount?.id;
      const c = store.conversation(id);
      const { cwd: originalCwd, createdAt } = c;
      const activeAccount = () =>
        activation === started &&
        !ctx.accountRetiring &&
        ctx.store === store &&
        ctx.engine === engine &&
        ctx.activeAccount?.id === owner &&
        (!lease || lease.current());
      const movable = () =>
        c.mode === "code" &&
        !c.cloudHosted &&
        !c.cloudEnvironmentId &&
        !c.incognito &&
        !c.archived &&
        !c.importedSessionResumePending &&
        (c.environment?.kind ?? "local") === "local" &&
        (!c.sessionAuthors ||
          (!!owner &&
            c.sessionAuthors.ownerAccountUuid === owner &&
            c.sessionAuthors.viewerAccountUuid === owner));
      const hasWorktree = () =>
        c.worktree ||
        c.additionalWorktrees?.some((tree) => tree.state !== "deleted");
      const current = () =>
        activeAccount() &&
        movable() &&
        !hasWorktree() &&
        store.conversations.includes(c) &&
        c.createdAt === createdAt;
      const assertIdle = () => {
        if (
          c.codeNewTask ||
          c.turns.some((turn) => turn.status === "inProgress") ||
          engine.approvals.some((approval) => approval.conversationId === id)
        )
          throw Error(
            "Wait for the current turn or request to finish before changing folders.",
          );
        engine.assertIdle(id);
      };
      if (!activeAccount())
        throw Error("The account changed during this request.");
      if (!movable())
        throw Error("Only a local Code session can change its working folder.");
      if (hasWorktree())
        throw Error("A worktree session cannot change its working folder.");
      if (
        lease &&
        (lease.expected.cwd !== originalCwd ||
          lease.expected.createdAt !== createdAt)
      )
        throw Error("The session changed during folder selection.");
      assertIdle();
      store.assertLocalCodeLifecycleAvailable();
      ctx.allowedFolder(cwd);
      const real = fs.realpathSync(cwd);
      const directory = fs.statSync(real);
      if (!directory.isDirectory()) throw Error("Choose an existing folder.");
      ctx.services.workspaceTrust?.assert({ mode: "code", cwd: real });
      const result = {
        status: "ok" as const,
        cwd: real,
        transcriptRelocated: true,
      };
      if (originalCwd && realFolder(originalCwd) === real)
        return { ...result, changed: false };

      const release = beginCodeSessionLifecycle(c);
      try {
        await ctx.terminals?.closeConversation(id);
        if (!activeAccount())
          throw Error("The account changed during this request.");
        if (!current() || c.cwd !== originalCwd)
          throw Error("The session changed while closing its terminal.");
        assertIdle();
        const latest = fs.statSync(cwd);
        if (
          fs.realpathSync(cwd) !== real ||
          !latest.isDirectory() ||
          latest.dev !== directory.dev ||
          latest.ino !== directory.ino
        )
          throw Error(
            "The selected directory changed while closing the terminal. Choose it again.",
          );
        ctx.allowedFolder(cwd);
        ctx.services.workspaceTrust?.assert({ mode: "code", cwd: real });
        const source = departingScratch(
          originalCwd,
          real,
          engine.defaultWorkspace,
        );
        store.commitLocalCodeHistory(
          c,
          { cwd: real, updatedAt: Date.now() },
          undefined,
          () => current() && c.cwd === originalCwd,
        );
        if (originalCwd) ctx.selectedFolders.add(originalCwd);
        ctx.selectedFolders.add(real);
        ctx.services.browser?.host.close(id);
        const moved = () => current() && c.cwd === real;
        const { filesCarried, scratchCarried } = source
          ? await carryScratchFiles(source, real, moved)
          : {};
        if (!moved())
          throw Error(
            "The folder changed, but the session is no longer available.",
          );
        if (source && filesCarried) {
          const incomplete =
            filesCarried.outcome !== "copied" ||
            filesCarried.alreadyThere > 0 ||
            filesCarried.notCopied > 0 ||
            source.cwd !== source.real;
          store.commitLocalCodeHistory(
            c,
            {
              scratchCarried,
              scratchFilesLeftIn: incomplete ? source.real : undefined,
            },
            undefined,
            moved,
          );
        }
        ctx.push?.({ type: "conversation", conversation: structuredClone(c) });
        return {
          ...result,
          changed: true,
          ...(filesCarried ? { filesCarried } : {}),
        };
      } finally {
        release();
      }
    },
  );
}
