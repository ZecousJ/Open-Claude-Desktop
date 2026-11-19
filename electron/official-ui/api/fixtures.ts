/**
 * Answers for the claude.ai endpoints the official front-end calls that have
 * no Claudex counterpart yet. Each shape was read from the consumer in the
 * official modules (cited per line); empty compatibility shapes are not proof of real account state. Security
 * inventory and eligibility without a counterpart return explicit unavailable errors. Endpoints that get a real
 * Claudex-backed answer live in their own modules and run before this one.
 */
import type http from "node:http";
import { officialCodeUserSettingsOrganization } from "../../../shared/official-code-user-settings";
import { empty, reply } from "./context";

export async function fixtureRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
): Promise<boolean> {
  const method = req.method ?? "GET";
  // Composer notices (shared-0 jg): notices[]
  if (/\/chat_conversations\/[^/]+\/composer_notices$/.test(p))
    return reply(res, { notices: [] });
  // Claudex does not quote or sell Anthropic consumer subscriptions. Never
  // invent a $20/$200 offer, an active Pro tier, or a Stripe balance.
  if (method === "POST" && /^\/api\/billing\/[^/]+\/consumer_pricing$/.test(p))
    return reply(
      res,
      {
        error: {
          type: "not_found_error",
          message:
            "Vendor subscription pricing is not available for this account.",
        },
      },
      404,
    );
  // Apps the account authorised with OAuth (shared-3 lS): none on Claudex.
  if (/^\/api\/oauth\/organizations\/[^/]+\/oauth_tokens$/.test(p))
    return reply(res, []);
  // The public connector and extension directories (c384c256e Me/Ne): Claudex has none to browse here.
  if (/\/directory\/(plugins|mcp-servers)$/.test(p))
    return reply(res, {
      plugins: [],
      servers: [],
      items: [],
      data: [],
      has_more: false,
      next_cursor: null,
      next_page: null,
    });
  if (method === "GET" && /^\/api\/organizations\/[^/]+\/dxt\/(extensions|installable_extensions)$/.test(p))
    return reply(res, { entries: [], total: 0 });
  if (/^\/api\/organizations\/[^/]+\/dxt(?:\/|$)/.test(p))
    return reply(res, {
      error: {
        type: "not_found_error",
        message: "The extension directory has been disabled on your computer.",
      },
    }, 404);
  if (p.endsWith("/subscription_details"))
    return reply(
      res,
      {
        error: {
          type: "not_found_error",
          message: "No vendor subscription is available for this account.",
        },
      },
      404,
    ); // c4a931512 Fn, c9e81e7b9 ve
  if (p.endsWith("/reflections/settings")) return reply(res, {}); // shared-l-m-0 Tm
  if (p.endsWith("/pending_domain_claim")) return reply(res, {}); // shared-l-p-m-w-4 xU
  if (p === "/api/account/raven_eligible")
    return reply(res, {
      eligible: false,
      reason_code: null,
      parent_organization_name: null,
    }); // shared-l-p-m-w-2
  if (/\/experiences\/[a-z_]+$/.test(p)) return reply(res, { experiences: [] }); // shared-4 19406
  if (p.endsWith("/experiences/track") || p.endsWith("/experiences/action"))
    return empty(res);
  if (p.endsWith("/library/discover/browse"))
    return reply(res, { items: [], next_cursor: null }); // shared-0 22675
  if (p.endsWith("/library/discover/home"))
    return reply(res, { sections: [], items: [] });
  if (/^\/api\/frame\/types\/[^/]+\/instances$/.test(p))
    return reply(res, { instances: [], default: null }); // 66f52f35 Rn
  if (p === "/v1/code/last_used_environment")
    return reply(res, { environment_id: null }); // caec4a2d4: h?.environment_id
  if (p === "/api/frame/artifacts")
    return reply(res, { artifacts: [], next_page_token: null }); // c86d8805d
  if (p === "/api/frame/frames/external") return reply(res, { frames: [] });
  if (p === "/api/frame/track") return empty(res);
  // These are security facts, not harmless empty catalog placeholders. Active
  // sessions are not trusted devices; sign-in challenges are not MFA inventory;
  // deleteAccount existence does not prove deletion eligibility.
  const securityUnavailable = {
    "/api/auth/trusted_devices": {
      code: "trusted_devices_unavailable",
      message: "Claudex trusted-device settings are unavailable in this interface. This does not mean your account has no trusted devices.",
    },
    "/api/auth/mfa": {
      // Pinned shared-m-2 pw + Account gr consume this exact error code to
      // show unavailable instead of falsely displaying Off / Set up.
      code: "mfa_unavailable",
      message: "Claudex multi-factor authentication settings are unavailable in this interface. Your existing account security settings are unchanged.",
    },
    "/api/account/deletion-allowed": {
      code: "account_deletion_eligibility_unavailable",
      message: "Claudex account deletion eligibility cannot be verified in this interface. No account deletion has been performed.",
    },
  };
  if (Object.hasOwn(securityUnavailable, p)) {
    const unavailable = securityUnavailable[p as keyof typeof securityUnavailable];
    return reply(res, {
      type: "error",
      error: {
        type: "api_error",
        message: unavailable.message,
        details: { error_code: unavailable.code },
      },
    }, method === "GET" || method === "HEAD" ? 503 : 501, { "Cache-Control": "private, no-store" });
  }
  if (p.endsWith("/referral/eligibility"))
    return reply(res, { eligible: false }); // shared-l-0 DF
  if (/^\/api\/stripe\/[^/]+\/balance$/.test(p))
    return reply(
      res,
      {
        error: {
          type: "not_found_error",
          message: "Vendor billing balance is not available.",
        },
      },
      404,
    );
  if (p.endsWith("/subscription/refund/eligibility"))
    return reply(res, { eligible: false });
  if (p.endsWith("/paused_subscription_details"))
    return reply(
      res,
      { error: { type: "not_found_error", message: "No paused subscription" } },
      404,
    );
  if (p.endsWith("/payment_method"))
    return reply(res, {
      payment_method: null,
      has_chargeable_saved_payment_method: false,
    });
  if (p.endsWith("/prepaid/bundles")) return reply(res, { bundles: [] });
  if (p.endsWith("/overage_credit_grant")) return reply(res, {});
  if (p.endsWith("/notification/preferences"))
    return reply(res, {
      preferences: { feature_preference: {} },
      effective_preferences: {},
      push_reachability: {
        platforms: [],
        has_active_channel: false,
        most_recent_token_refresh: null,
      },
      admin_spend_alerts_available: false,
      admin_join_request_alerts_available: false,
    });
  if (p.endsWith("/user_artifacts/count")) return reply(res, { count: 0 }); // c230724a2
  if (p.endsWith("/user_artifacts")) return reply(res, { artifacts: [] });
  if (p.endsWith("/kyc_status"))
    return reply(res, { status: "not_required", should_poll: false });
  if (p.endsWith("/permission_mode_policy"))
    return reply(res, {
      auto_permissions: { allowed: true, managed: false },
      bypass_permissions: { allowed: true, managed: false },
    });
  if (p.endsWith("/activation/cowork/tasks"))
    return reply(res, { tasks: [], panel_dismissed_at: null });
  if (p.endsWith("/member_invites") || p === "/api/organizations/discoverable")
    return reply(res, []);
  if (p.endsWith("/feature_settings"))
    return reply(res, { settings: [], forced_settings: [] });
  if (officialCodeUserSettingsOrganization(p))
    return reply(res, { error: { message: "Cloud Code user settings are unavailable." } }, 404);
  if (p.endsWith("/cowork_settings")) return reply(res, {});
  if (p.endsWith("/members_limit"))
    return reply(res, { limit: 1, count: 1, can_invite: false });
  if (p.endsWith("/subscription_status"))
    return reply(
      res,
      {
        error: {
          type: "not_found_error",
          message: "No vendor subscription is available for this account.",
        },
      },
      404,
    );
  if (p.endsWith("/sync/settings")) return reply(res, {});
  if (p.endsWith("/sync/github/auth"))
    return reply(res, { is_connected: false, authenticated: false });
  if (p.endsWith("/plugins/list-plugins"))
    return reply(res, { plugins: [], pagination: { has_more: false } });
  if (method === "GET" && /^\/api\/organizations\/[^/]+\/marketplaces\/list-(?:account|default)-marketplaces$/.test(p))
    return reply(res, { marketplaces: [] });
  if (p.endsWith("/cowork_plugin_metadata")) return reply(res, {});
  if (/\/styles$|\/integrations$|\/model_preferences$/.test(p))
    return reply(res, []);
  if (/\/feature_flags$/.test(p)) return reply(res, {});
  // Desktop-surface startup reads (shapes from their consumers in the build).
  if (
    /^\/v1\/environment_providers\/private\/organizations\/[^/]+\/environments$/.test(
      p,
    )
  )
    return reply(res, { environments: [], has_more: false }); // c43c83380 ve: environments[], has_more
  if (p.endsWith("/claude_in_slack/workspace_claims"))
    return reply(res, { claims: [] }); // c2d20a90c: claims[]
  if (p === "/v1/privacy-consents" || p === "/v1/privacy-consents/check")
    return reply(
      res,
      {
        type: "error",
        error: { type: "not_found_error", message: "Not found" },
      },
      404,
    ); // as claude.ai answered /check (2026-10-30)
  if (/\/admin_requests\/[a-z_]+$/.test(p)) return reply(res, []); // c4a931512 O: array
  if (p === "/v1/code/agent-proxy/provisioning-links" && method === "GET")
    return reply(res, { data: [], has_more: false });
  if (p.endsWith("/members/counts"))
    return reply(res, {
      total: 1,
      by_seat_tier: { unassigned: 1 },
      pending_invites_total: 0,
      pending_invites_by_seat_tier: {},
      no_seat_members: 0,
      no_seat_pending_invites: 0,
    }); // recorded 2026-10-30
  if (p.endsWith("/subscription/scheduled_seat_tier_changes"))
    return reply(res, { scheduled_changes: [] });
  if (p.endsWith("/is_pure_usage_based"))
    return reply(res, { is_pure_usage_based: false }); // c1fdbb156
  if (/^\/api\/billing\/[^/]+\/gift\/purchase_eligibility$/.test(p))
    return reply(res, { eligible: false }); // shared-0 24854
  if (p === "/v1/code/promo/cloud_credit")
    return reply(res, { claimed: false }); // c17a75a4f U: !e?.claimed → null
  if (p === "/api/account/sse_invoice_cap_block_status")
    return reply(res, { blocked: false, cap_usd_cents: null }); // shared-0 Y3
  if (p.endsWith("/feature_overview"))
    return reply(
      res,
      { error: { type: "not_found_error", message: "Not found" } },
      404,
    ); // c9675fdeb: 404 → []
  // Cloud Code sessions (/v1/code): none until the runner is wired.
  if (p === "/v1/code/sessions/watch") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": no cloud sessions\n\n");
    return true;
  }
  if (p === "/v1/code/sessions")
    return reply(res, { data: [], has_more: false });
  if (p.endsWith("/reflections/time_spent")) return empty(res);
  if (p.startsWith("/api/event_logging/") || p === "/api/v2/rum")
    return empty(res);
  if (/\/events(?:\/|$)|\/log(?:\/|$)|\/telemetry(?:\/|$)/.test(p))
    return empty(res);
  return false;
}
