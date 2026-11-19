import type http from "node:http";
import { z } from "zod";
import { preference } from "../../../shared/settings-extras";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

const route =
  /^\/api\/organizations\/([^/]+)\/__claudex\/privacy\/(status|reporting|uploads|feedback)(?:\/([^/]+))?$/;
const setting = z.strictObject({ consented: z.boolean() });
const cursorSchema = z.string().min(1).max(4096);
const reportStatus = z
  .object({
    diagnostics: z.boolean(),
    feedback: z.boolean(),
    allowConversationExcerpt: z.boolean(),
    consented: z.boolean(),
  })
  .nullable();
const dataStatus = z.object({ feedback: z.object({ supported: z.boolean() }) });

export async function nativePrivacyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: AdapterContext,
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = route.exec(url.pathname);
  if (!match) return false;
  const [, organization, action, resource] = match;
  const method = req.method ?? "GET";
  const fail = (status: number, message: string) =>
    reply(
      res,
      { type: "error", error: { type: "invalid_request_error", message } },
      status,
    );
  const call = ctx.localCall;
  if (ctx.readOnly || !call)
    return fail(403, "Privacy controls are unavailable on this host.");
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const current = () =>
    activation != null &&
    ctx.isCurrent?.() === true &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation;
  const retired = () => fail(409, "The account changed. Reopen Privacy.");
  if (!owner || organization !== organizationUuid(owner))
    return fail(404, "Account not found.");
  if (!current()) return retired();
  const respond = (body: unknown) => (current() ? reply(res, body) : retired());
  const status = async () => reportStatus.parse(await call("reportingStatus"));
  const entries = [...url.searchParams];
  const cursor =
    entries.length === 1 && entries[0][0] === "cursor"
      ? cursorSchema.safeParse(entries[0][1])
      : undefined;
  try {
    if (
      action === "status" &&
      method === "GET" &&
      !resource &&
      !entries.length
    ) {
      const [reporting, data] = await Promise.allSettled([
        status(),
        call("privacyDataStatus"),
      ]);
      return respond({
        reporting: reporting.status === "fulfilled" ? reporting.value : null,
        feedback:
          data.status === "fulfilled"
            ? dataStatus.parse(data.value).feedback.supported
            : null,
      });
    }
    if (
      action === "reporting" &&
      method === "PUT" &&
      !resource &&
      !entries.length
    ) {
      const input = setting.safeParse(await readBoundedJson(req, 1024));
      if (!current()) return retired();
      if (!input.success) return fail(400, "Choose a reporting preference.");
      const reporting = await status();
      if (!current()) return retired();
      if (!reporting?.diagnostics && !reporting?.feedback)
        return fail(403, "This service does not collect reports.");
      const { consented } = input.data;
      const settings = ctx.settings();
      if (preference(settings, "helpImproveClaudex") !== consented)
        await call("saveSettings", {
          ...settings,
          helpImproveClaudex: consented,
        });
      if (!current()) return retired();
      if (preference(ctx.settings(), "helpImproveClaudex") !== consented)
        return fail(409, "The reporting preference changed. Reopen Privacy.");
      return respond({ ...reporting, consented });
    }
    if (action === "uploads" || action === "feedback") {
      if (method === "GET" && !resource && (!entries.length || cursor?.success))
        return respond(
          await call(
            action === "uploads" ? "uploadedFiles" : "feedbackHistory",
            cursor?.success ? { cursor: cursor.data } : undefined,
          ),
        );
      if (method === "DELETE" && resource && !entries.length) {
        const id = decodeURIComponent(resource);
        return respond(
          await call(
            action === "uploads" ? "deleteUploadedFile" : "withdrawFeedback",
            id,
          ),
        );
      }
    }
    return fail(400, "Invalid privacy request.");
  } catch (error) {
    if (!current()) return retired();
    if (error instanceof RequestBodyError)
      return fail(error.status, error.message);
    return fail(503, "The privacy request could not be confirmed. Try again.");
  }
}
