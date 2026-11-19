import { apiManagementBodyLimit, apiManagementFailure, executeApiManagement, type ApiManagement } from "../../shared/official-api-management";

export async function apiManagementFetch(
  request: Request,
  url: URL,
  api: ApiManagement | undefined,
  current: () => boolean,
  body: (request: Request, maxBytes: number) => Promise<Uint8Array | null>,
) {
  const headers = { "Cache-Control": "no-store" };
  if (!api)
    return Response.json(apiManagementFailure("API management is unavailable.", 404).data, { status: 404, headers });
  const check = () => {
    request.signal.throwIfAborted();
    if (!current()) throw new DOMException("The active account changed.", "AbortError");
  };
  const read = async (): Promise<unknown> => {
    const bytes = await body(request, apiManagementBodyLimit);
    if (!bytes) throw Object.assign(Error("Request body is too large."), { status: 413 });
    try { return bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {}; }
    catch { throw Object.assign(Error("Choose a valid JSON object."), { status: 400 }); }
  };
  const { status, data } = await executeApiManagement(request.method, url, read, api, check);
  return status === 204 ? new Response(null, { status, headers }) : Response.json(data, { status, headers });
}
