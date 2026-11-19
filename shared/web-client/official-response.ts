import {
  isOfficialResponseTransferId,
  officialResponseChunkBytes,
  officialResponseChunkPath,
} from "../official-response-transfer";
import {
  isOfficialMcpSessionId,
  officialUiReadMaxBytes,
  officialUiTransferMaxBytes,
  type OfficialUiReadResponse,
} from "../official-ui-web";
import { readAttachmentObject } from "../attachment-object";

function invalidResponse(): never {
  throw new Error("The official Web response was not valid.");
}

function parseResponse(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    !("contentType" in value) ||
    !("body" in value)
  )
    invalidResponse();
  const { status, contentType, body } = value;
  const contentDisposition =
    "contentDisposition" in value ? value.contentDisposition : undefined;
  const bodyEncoding = "bodyEncoding" in value ? value.bodyEncoding : undefined;
  const mcpSessionId = "mcpSessionId" in value ? value.mcpSessionId : undefined;
  const retryAfter = "retryAfter" in value ? value.retryAfter : undefined;
  const frameRefusal = "frameRefusal" in value ? value.frameRefusal : undefined;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599 ||
    typeof contentType !== "string" ||
    !(body instanceof Uint8Array) ||
    body.byteLength > officialUiReadMaxBytes ||
    (contentDisposition !== undefined &&
      typeof contentDisposition !== "string") ||
    (bodyEncoding !== undefined && bodyEncoding !== "gzip") ||
    (mcpSessionId !== undefined && !isOfficialMcpSessionId(mcpSessionId)) ||
    (retryAfter !== undefined && retryAfter !== "1") ||
    (frameRefusal !== undefined && frameRefusal !== "create_in_flight")
  )
    invalidResponse();
  return {
    answer: {
      status,
      contentType,
      body,
      ...(contentDisposition !== undefined ? { contentDisposition } : {}),
      ...(bodyEncoding !== undefined ? { bodyEncoding } : {}),
      ...(mcpSessionId !== undefined ? { mcpSessionId } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(frameRefusal !== undefined ? { frameRefusal } : {}),
    } satisfies OfficialUiReadResponse,
    ticket: "responseTransfer" in value ? value.responseTransfer : undefined,
    offset: "responseOffset" in value ? value.responseOffset : undefined,
    object: "objectTransfer" in value ? value.objectTransfer : undefined,
  };
}

export async function collectOfficialResponse({
  initial,
  allowTransfer,
  isCurrent,
  readChunk,
  readFallback,
}: {
  initial: unknown;
  allowTransfer: boolean;
  isCurrent: () => boolean;
  readChunk: (path: string) => Promise<unknown>;
  readFallback?: () => Promise<unknown>;
}): Promise<OfficialUiReadResponse> {
  const { answer, ticket, offset, object } = parseResponse(initial);
  if (offset !== undefined) invalidResponse();
  if (object !== undefined) {
    if (!readFallback || !allowTransfer || ticket !== undefined || answer.status !== 200 ||
        answer.body.byteLength !== 0 || !object || typeof object !== "object" ||
        !("url" in object) || typeof object.url !== "string" ||
        !("size" in object) || typeof object.size !== "number" ||
        !Number.isSafeInteger(object.size) || object.size <= 0 || object.size > officialUiTransferMaxBytes)
      invalidResponse();
    if (!isCurrent()) throw Error("The account changed during this request.");
    let data: Uint8Array;
    try {
      data = await readAttachmentObject(object.url, object.size);
    } catch {
      if (!isCurrent()) throw Error("The account changed during this request.");
      return collectOfficialResponse({ initial: await readFallback(), allowTransfer, isCurrent, readChunk });
    }
    if (!isCurrent()) throw Error("The account changed during this request.");
    return { ...answer, body: data };
  }
  if (ticket === undefined) return answer;
  if (
    !allowTransfer ||
    !ticket ||
    typeof ticket !== "object" ||
    !("id" in ticket) ||
    !("totalBytes" in ticket)
  )
    invalidResponse();
  const { id, totalBytes } = ticket;
  if (
    !isOfficialResponseTransferId(id) ||
    typeof totalBytes !== "number" ||
    !Number.isInteger(totalBytes) ||
    totalBytes <= officialUiReadMaxBytes ||
    totalBytes > officialUiTransferMaxBytes ||
    answer.body.byteLength !== officialResponseChunkBytes
  )
    invalidResponse();
  const assertCurrent = () => {
    if (!isCurrent())
      throw new Error("The account changed during this request.");
  };
  assertCurrent();
  const body = new Uint8Array(totalBytes);
  body.set(answer.body);
  for (
    let offset = answer.body.byteLength;
    offset < totalBytes;
    offset += officialResponseChunkBytes
  ) {
    const value = await readChunk(officialResponseChunkPath(id, offset));
    assertCurrent();
    const chunk = parseResponse(value);
    if (
      chunk.answer.status !== 200 ||
      chunk.offset !== offset ||
      chunk.ticket !== undefined ||
      chunk.answer.body.byteLength !==
        Math.min(officialResponseChunkBytes, totalBytes - offset)
    )
      invalidResponse();
    body.set(chunk.answer.body, offset);
  }
  return { ...answer, body };
}
