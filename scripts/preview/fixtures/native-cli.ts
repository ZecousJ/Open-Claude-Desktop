/**
 * Explicit renderer-only CLI import data. These sessions and paths are
 * synthetic: no CLI file, trusted folder, Electron IPC or model is touched.
 * Without ?nativeCli=some the existing unsupported/empty bridge is unchanged.
 */
import type { Conversation, DesktopAPI } from "../../../shared/types";
import type { ResumableSession } from "../../../shared/resume-sessions";
import type { FixtureContext } from "./index";

export function nativeCliFixture({
  params,
  state,
  origin,
  emit,
}: FixtureContext): Partial<DesktopAPI> {
  if (params.get("nativeCli") !== "some") return {};
  const sessions: ResumableSession[] = [1, 2].map((index) => ({
    handle: `00000000-0000-4000-8000-00000000000${index}`,
    title: `Synthetic CLI session ${index}`,
    cwd: `/synthetic/cli-fixture/workspace-${index}`,
    lastActivityAt: origin - index * 60_000,
    liveness: "closed",
    folderMissing: false,
  }));
  return {
    probeImportableCliSessions: async () => ({ count: sessions.length }),
    listResumableSessions: async () => structuredClone(sessions),
    importAllCliSessions: async () => {
      const provider = state.settings.providers.find(
        (entry) => entry.id === state.settings.activeProviderId,
      );
      if (!provider) throw new Error("Synthetic CLI fixture has no provider.");
      const pending = sessions.splice(0);
      for (const session of pending) {
        const conversation: Conversation = {
          id: `synthetic-cli-${session.handle}`,
          importedCliSessionId: session.handle,
          importedHistory: true,
          title: session.title ?? "Synthetic CLI session",
          mode: "code",
          cwd: session.cwd,
          providerId: provider.id,
          model: provider.model,
          pinned: false,
          archived: false,
          createdAt: session.lastActivityAt,
          updatedAt: session.lastActivityAt,
          turns: [],
        };
        state.conversations.unshift(conversation);
        emit({ type: "conversation", conversation: structuredClone(conversation) });
      }
      return { imported: pending.length, skipped: 0 };
    },
  };
}
