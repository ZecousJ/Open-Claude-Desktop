/**
 * Every tool row in the three modes: the chat audit's tool conversations
 * (commands, a refused edit, web fetches, a viewed image, a pause, a
 * compaction, connector calls, agents, file changes) copied into Cowork and
 * Code. preview/app.html?gallery=1 adds "Gallery: chat|cowork|code …".
 */
import type { Conversation, Mode } from "../../../shared/types";
import { chatAuditConversations } from "./chat-transcript-audit";
import type { FixtureDomain } from "./index";

const sources = ["c-ca-tools", "c-ca-tools2"];

export function galleryConversations(origin: number): Conversation[] {
  const audit = chatAuditConversations(origin).filter((c) =>
    sources.includes(c.id),
  );
  const modes: Mode[] = ["chat", "cowork", "code"];
  return modes.flatMap((mode, m) =>
    audit.map((source, s) => ({
      ...structuredClone(source),
      id: `g-${mode}-${s}`,
      threadId: `thread-g-${mode}-${s}`,
      title: `Gallery: ${mode} ${s + 1}`,
      mode,
      cwd: mode === "chat" ? undefined : "/Users/fixture/gallery",
      updatedAt: origin + 20_000_000 + m * 10 + s,
    })),
  );
}

export const toolGalleryFixture: FixtureDomain = {
  params: { gallery: "1" },
  bridge({ params, state, origin }) {
    if (
      params.get("gallery") === "1" &&
      !state.conversations.some((c) => c.id === "g-chat-0")
    )
      state.conversations.unshift(...galleryConversations(origin));
    return {};
  },
};
