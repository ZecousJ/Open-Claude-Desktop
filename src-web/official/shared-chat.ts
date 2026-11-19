import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { SharedChatContent } from "../../shared/sharing-api";
import { statusOf } from "../../shared/web-client/errors";
import { parseWebRoute } from "../../src/web/routes";

export const officialSharedChatReadPath = "/api/__claudex/shared-chat-snapshot";

export function officialSharedChatToken(pathname: string) {
  const route = parseWebRoute(pathname);
  return route.kind === "shared" ? route.token : undefined;
}

export function isOfficialSharedChatRead(url: URL, id: string, organization?: string) {
  const snapshot = `/chat_snapshots/${id}`;
  return url.search === "?rendering_mode=messages&render_all_tools=true" &&
    (url.pathname === `/api${snapshot}` ||
      (organization !== undefined && url.pathname === `/api/organizations/${organization}${snapshot}`));
}

const messageUuid = (index: number) =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

export async function readOfficialSharedChatSnapshot({ read, token, id }: {
  read(token: string): Promise<SharedChatContent>;
  token: string;
  id: string;
}): Promise<OfficialUiReadResponse> {
  const answer = (status: number, value: unknown) => ({
    status,
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
  const unavailable = () => answer(404, { error: { type: "not_found_error" } });
  try {
    const chat = await read(token);
    if (chat.token !== token || chat.kind === "artifact") return unavailable();
    const snapshotAt = new Date(chat.snapshotAt).toISOString();
    return answer(200, {
      uuid: id,
      snapshot_name: chat.title,
      created_by: chat.owner,
      created_at: snapshotAt,
      is_public: false,
      chat_messages: chat.messages.map((message, index) => ({
        uuid: messageUuid(index + 1),
        parent_message_uuid: messageUuid(index),
        index,
        sender: message.role === "user" ? "human" : "assistant",
        text: message.text,
        content: [message.activity?.join(", "), message.text]
          .filter(Boolean)
          .map((text) => ({ type: "text", text, citations: [] })),
        created_at: snapshotAt,
        updated_at: snapshotAt,
        attachments: [],
        files: [],
        files_v2: [],
        sync_sources: [],
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const status = statusOf(error);
    return status === 403 || status === 404
      ? unavailable()
      : answer(503, { error: { type: "api_error" } });
  }
}
