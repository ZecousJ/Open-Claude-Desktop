import {
  officialUiConversationMutation,
  officialUiRequestMaxBytes,
  parseOfficialChatReadState,
  type OfficialUiReadRequest,
} from "../../shared/official-ui-web";

/** Fail closed before dispatching a Web mutation to the desktop route adapter. */
export function validateOfficialConversationMutation(
  request: OfficialUiReadRequest,
): boolean {
  const kind = officialUiConversationMutation(request.method, request.path);
  if (
    !kind ||
    (request.body !== undefined && !(request.body instanceof Uint8Array))
  )
    return false;
  const bytes = request.body ?? new Uint8Array();
  if (bytes.byteLength > officialUiRequestMaxBytes) return false;
  if (
    bytes.length &&
    !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")
  )
    return false;
  try {
    const body = bytes.length
      ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const keys = Object.keys(body);
    if (request.path.endsWith("?rendering_mode=raw"))
      return kind === "update" && keys.length === 1 && typeof body.is_archived === "boolean";
    if (kind === "update")
      return (
        keys.length > 0 &&
        keys.every((key) =>
          key === "name"
            ? typeof body.name === "string" &&
              !!body.name.trim() &&
              body.name.length <= 1000
            : (key === "is_starred" || key === "is_archived") &&
              typeof body[key] === "boolean",
        )
      );
    if (kind === "read")
      return !!parseOfficialChatReadState(request.method, body);
    if (kind === "stop")
      return keys.length === 0 || keys.length === 1 && keys[0] === "completion_request_id" &&
        typeof body.completion_request_id === "string" &&
        /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(body.completion_request_id);
    return keys.length === 0;
  } catch {
    return false;
  }
}
