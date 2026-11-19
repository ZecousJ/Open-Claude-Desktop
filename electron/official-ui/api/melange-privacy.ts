import type http from "node:http";
import { z } from "zod";
import { officialMelangePrivacyRoute } from "../../../shared/official-melange";
import { MelangeConflictError, MelangeConsentError, MelangeLimitError, melangeConsentDecisionSchema } from "../../memory/melange";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

const consentType = z.literal("memory.sensitive_info");
const checkInput = z.strictObject({ consent_type: consentType });
const noticeSource = z.literal("sensitive_memory_couldnt_save_notice");
const personalInput = checkInput.extend({
  consent_decision: melangeConsentDecisionSchema,
  consent_lang_localization_code: z.string().min(1).max(100),
  source: z.literal([
    "sensitive_memory_toggle",
    "sensitive_memory_couldnt_save_notice",
    "sensitive_memory_nudge_banner",
    "sensitive_memory_popup_modal",
  ]),
});
const orgInput = personalInput.extend({
  organization_uuid: z.uuid(),
  source: z.literal("sensitive_memory_org_admin_toggle"),
});
const cleanupInput = z.strictObject({ consent_source: noticeSource.optional() });

export async function melangePrivacyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
) {
  const route = officialMelangePrivacyRoute(req.method ?? "GET", url.pathname, url.search);
  if (!route) return false;

  const error = (status: number, message: string) =>
    reply(res, { type: "error", error: { type: "invalid_request_error", message } }, status);
  const owner = ctx.account()?.id;
  const identity = ctx.sessionIdentity?.();
  const current = () => ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === identity && ctx.isCurrent?.() !== false;
  if (!owner || !current()) return error(401, "Sign in to continue.");
  const organization = organizationUuid(owner);
  if (route.organization && route.organization !== organization ||
      url.pathname.startsWith("/v1/") && req.headers["x-organization-uuid"] !== organization)
    return error(404, "Organization not found.");

  try {
    const service = await ctx.melange?.();
    if (!current()) return error(409, "The account changed.");
    if (!service) return error(501, "Sensitive memory is unavailable.");
    const respond = (body: unknown) => current() ? reply(res, body) : error(409, "The account changed.");
    if (route.operation === "cleanup-status") return respond(await service.sensitiveCleanupStatus());
    if (route.operation === "org-consent-read") {
      const { organizationDecision } = await service.sensitiveConsent();
      return respond({ consent: organizationDecision ? { consent_decision: organizationDecision } : null });
    }
    if (route.operation !== "cleanup-start" && !/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? ""))
      return error(400, "Invalid sensitive memory request.");
    const body = await readBoundedJson(req, 4096);
    if (!current()) return error(409, "The account changed.");
    if (route.operation === "cleanup-start") {
      const parsed = cleanupInput.safeParse(body);
      if (!parsed.success) return error(400, "Invalid sensitive memory cleanup request.");
      return respond(await service.startSensitiveCleanup(parsed.data.consent_source));
    }
    if (route.operation === "consent-check") {
      if (!checkInput.safeParse(body).success) return error(400, "Invalid sensitive memory consent request.");
      const { consent_decision, disabled_by_org_admin } = await service.sensitiveConsent();
      return respond({ consent_decision, disabled_by_org_admin });
    }
    const org = route.operation === "org-consent-write";
    if (org && body.organization_uuid !== organization) return error(404, "Organization not found.");
    const parsed = (org ? orgInput : personalInput).safeParse(body);
    if (!parsed.success) return error(400, "Invalid sensitive memory consent request.");
    const { consent_decision: decision, source, consent_lang_localization_code: locale } = parsed.data;
    await service.setSensitiveConsent({ decision, source, locale }, org, async () => {
      const status: unknown = await ctx.call("memoryStatus", { snapshotOnly: true });
      const prefs = z.object({ prefs: z.object({ generate: z.boolean() }) }).parse(status).prefs;
      if (!current()) throw Error("The account changed.");
      return prefs.generate ? "classic" : "off";
    });
    return respond(org ? { consent: { consent_decision: decision } } : { consent_decision: decision });
  } catch (e) {
    if (res.destroyed) return true;
    if (!current()) return error(409, "The account changed.");
    if (e instanceof RequestBodyError) return error(e.status, e.message);
    if (e instanceof MelangeLimitError) return error(413, e.message);
    if (e instanceof MelangeConsentError) return error(400, e.message);
    if (e instanceof MelangeConflictError) return error(409, "Memory changed. Try again.");
    return error(503, "Sensitive memory is temporarily unavailable.");
  }
}
