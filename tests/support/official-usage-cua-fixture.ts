import fs from "node:fs";
import { ok, fail, type MockSub2Api, type MockRequest } from "./sub2api-mock";

/** Synthetic accounting responses for original-settings UI acceptance; no model calls. */
export function installOfficialUsageFixture(
  mock: MockSub2Api,
  owner: number,
  faultFile?: string,
) {
  const now = Date.now();
  const rows = Array.from({ length: 15 }, (_, index) => {
    const actual =
      index < 2 ? 0.0000128 : index === 2 ? 0 : 0.0125 * (index + 1);
    const standard = actual / 0.2;
    return {
      id: 1000 + index,
      model: index % 3 === 0 ? "gpt-5.4" : "gpt-5.5",
      created_at: new Date(now - index * 6 * 3600_000).toISOString(),
      input_tokens: index < 4 ? 7 : 1200 + index * 100,
      output_tokens: index < 2 ? 5 : index < 4 ? 7 : 300 + index * 10,
      cache_read_tokens: index < 4 ? 0 : 250,
      cache_creation_tokens: 0,
      actual_cost: actual,
      total_cost: standard,
      input_cost: standard / 2,
      output_cost: standard / 2,
      cache_read_cost: 0,
      cache_creation_cost: 0,
      rate_multiplier: 0.2,
      stream: true,
      reasoning_effort: "high",
      duration_ms: 750 + index * 250,
      first_token_ms: 120 + index * 20,
      api_key: { name: "Usage fixture key" },
      group: { name: "Usage fixture" },
      request_id: `usage-fixture-${index + 1}`,
      endpoint: "/v1/responses",
    };
  });
  const fault = () =>
    faultFile && fs.existsSync(faultFile)
      ? fs.readFileSync(faultFile, "utf8").trim()
      : "";
  mock.route("GET", "/api/v1/subscriptions", () => ok([]), { auth: "user" });
  mock.route(
    "GET",
    "/api/v1/claudex/spend-limit",
    (request) =>
      ok({
        limit_usd: 25,
        used_usd: request.userId === owner ? 1.2 : 0,
        resets_at: new Date(now + 15 * 86400_000).toISOString(),
      }),
    { auth: "user" },
  );
  const day = (value: string, timezone?: string | null) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  const filtered = (request: MockRequest) =>
    request.userId === owner
      ? rows.filter((row) => {
          const date = day(
            row.created_at,
            request.url.searchParams.get("timezone"),
          );
          return (
            (!request.url.searchParams.get("start_date") ||
              date >= request.url.searchParams.get("start_date")!) &&
            (!request.url.searchParams.get("end_date") ||
              date <= request.url.searchParams.get("end_date")!) &&
            (!request.url.searchParams.get("model") ||
              row.model === request.url.searchParams.get("model"))
          );
        })
      : [];
  const total = (items: typeof rows) =>
    items.reduce(
      (sum, row) => ({
        requests: sum.requests + 1,
        input_tokens: sum.input_tokens + row.input_tokens,
        output_tokens: sum.output_tokens + row.output_tokens,
        cache_read_tokens: sum.cache_read_tokens + row.cache_read_tokens,
        cache_creation_tokens: 0,
        total_tokens:
          sum.total_tokens +
          row.input_tokens +
          row.output_tokens +
          row.cache_read_tokens,
        actual_cost: sum.actual_cost + row.actual_cost,
        cost: sum.cost + row.total_cost,
      }),
      {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        total_tokens: 0,
        actual_cost: 0,
        cost: 0,
      },
    );
  mock.route(
    "GET",
    "/api/v1/usage/dashboard/stats",
    (request) => {
      if (fault() === "usage-overview-error")
        return fail(503, "Synthetic usage failure", "USAGE_UNAVAILABLE");
      const all = total(request.userId === owner ? rows : []);
      const today = total(
        request.userId === owner
          ? rows.filter(
              (row) => day(row.created_at) === day(new Date(now).toISOString()),
            )
          : [],
      );
      return ok({
        total_requests: all.requests,
        today_requests: today.requests,
        total_actual_cost: all.actual_cost,
        today_actual_cost: today.actual_cost,
        total_cost: all.cost,
        today_cost: today.cost,
        total_tokens: all.total_tokens,
        today_tokens: today.total_tokens,
        total_input_tokens: all.input_tokens,
        total_output_tokens: all.output_tokens,
        total_cache_read_tokens: all.cache_read_tokens,
        total_cache_creation_tokens: 0,
        today_input_tokens: today.input_tokens,
        today_output_tokens: today.output_tokens,
        today_cache_read_tokens: today.cache_read_tokens,
        today_cache_creation_tokens: 0,
        total_api_keys: 2,
        active_api_keys: 1,
        average_duration_ms: 2300,
        rpm: 0,
        tpm: 0,
        by_platform: [
          {
            platform: "openai",
            total_requests: all.requests,
            total_tokens: all.total_tokens,
            total_actual_cost: all.actual_cost,
            today_actual_cost: today.actual_cost,
          },
        ],
      });
    },
    { auth: "user" },
  );
  mock.route(
    "GET",
    "/api/v1/user/platform-quotas",
    (request) =>
      ok({
        platform_quotas: [
          {
            platform: "openai",
            daily_limit_usd: 10,
            daily_usage_usd: request.userId === owner ? 0.42 : 0,
            monthly_limit_usd: 100,
            monthly_usage_usd: request.userId === owner ? 12.3 : 0,
          },
        ],
      }),
    { auth: "user" },
  );
  mock.route(
    "GET",
    "/api/v1/usage/dashboard/trend",
    (request) => {
      if (fault() === "usage-breakdown-error")
        return fail(503, "Synthetic trend failure", "USAGE_UNAVAILABLE");
      const groups = new Map<string, typeof rows>();
      for (const row of filtered(request)) {
        const date =
          request.url.searchParams.get("granularity") === "hour"
            ? row.created_at.slice(0, 13) + ":00:00.000Z"
            : day(row.created_at, request.url.searchParams.get("timezone"));
        groups.set(date, [...(groups.get(date) ?? []), row]);
      }
      return ok({
        trend: [...groups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, items]) => ({ date, ...total(items) })),
      });
    },
    { auth: "user" },
  );
  mock.route(
    "GET",
    "/api/v1/usage/dashboard/models",
    (request) =>
      ok({
        models: ["gpt-5.5", "gpt-5.4"]
          .map((model) => ({
            model,
            ...total(filtered(request).filter((row) => row.model === model)),
          }))
          .filter((row) => row.requests > 0),
      }),
    { auth: "user" },
  );
  mock.route(
    "GET",
    "/api/v1/usage",
    (request) => {
      if (fault() === "usage-records-error")
        return fail(503, "Synthetic records failure", "USAGE_UNAVAILABLE");
      const items = filtered(request),
        page = Number(request.url.searchParams.get("page") || 1),
        size = Number(request.url.searchParams.get("page_size") || 10);
      return ok({
        items: items.slice((page - 1) * size, page * size),
        total: items.length,
        page,
        pages: Math.max(1, Math.ceil(items.length / size)),
      });
    },
    { auth: "user" },
  );
}
