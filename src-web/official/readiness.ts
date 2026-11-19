import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "../../shared/official-ui-web";
/** No override: a real runner must not be charged while tool/capability semantics remain open. */
export async function officialWebReadOnlyAction(
  _request: OfficialUiReadRequest,
): Promise<OfficialUiReadResponse> {
  return {
    status: 501,
    contentType: "application/json",
    body: new TextEncoder().encode(
      JSON.stringify({
        type: "error",
        error: { type: "not_supported" },
      }),
    ),
  };
}
