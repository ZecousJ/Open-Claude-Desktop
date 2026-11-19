/** Original Claudex activity component with an exact, readonly official-host client. */
import { useMemo, useEffect, useState, useCallback } from "react";
import { OfficialUsageActivity } from "./usage-activity-view";
import type { UsageActivityClient } from "../../src/settings/usage-activity/use-usage-activity";
export { cost as formatUsageCost } from "../../src/settings/usage-activity/format";
import { setLocale, useT, t } from "../../src/i18n";
import { cost } from "../../src/settings/usage-activity/format";
// Supplied by the pinned official shared module, never a second toast system.
// @ts-expect-error Delivered pinned JavaScript has no declaration file.
import { oS as useToasts } from "./shared-l-p-m-w-2-BMCa56Vr.js";
// @ts-expect-error Delivered pinned JavaScript has no declaration file.
import { p as useIntl } from "./vendor-intl-D9Num-b5.js";
import "./usage-activity-host.css";
export function createUsageActivityClient(
  owner: string,
  org: string,
  transport: typeof fetch = fetch,
): UsageActivityClient {
  const read = async (kind: string, query?: Record<string, string>) => {
    const search = new URLSearchParams({ ...query, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const response = await transport(
      `/api/organizations/${encodeURIComponent(org)}/claudex_usage_activity/${kind}?${search}`,
      { credentials: "same-origin", headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw Error("Usage could not be read.");
    const value = await response.json();
    if (
      value?.account_uuid !== owner ||
      value?.organization_uuid !== org ||
      !value.data
    )
      throw Error("Usage could not be read.");
    return value.data;
  };
  return {
    usageOverview: () => read("overview"),
    usageBreakdown: ({ start, end, granularity }) => read("breakdown", { start, end, granularity }),
    usageRecords: (query) =>
      read("records", {
        page: String(query.page),
        pageSize: String(query.pageSize),
        start: query.start ?? "",
        end: query.end ?? "",
        ...(query.model ? { model: query.model } : {}),
      }),
  };
}
export function useUsageLocale() {
  const intl = useIntl();
  const locale = intl.locale;
  const [ready, setReady] = useState<string>();
  useT();
  useEffect(() => {
    let current = true;
    setReady(undefined);
    void setLocale(locale, { persist: false, document: false }).then(() => {
      if (current) setReady(locale);
    });
    return () => {
      current = false;
    };
  }, [locale]);
  return {
    ready: ready === locale,
    text: t,
    money: (value: number) => cost(value, locale),
    date: (value: number | string) => new Date(value).toLocaleString(locale),
  };
}
export function HostUsageActivity({
  account,
  organization,
  revision = 0,
}: {
  account: any;
  organization: any;
  revision?: number;
}) {
  const intl = useIntl();
  const owner = account?.uuid,
    org = organization?.uuid,
    locale = intl.locale;
  const [ready, setReady] = useState<string>();
  const toasts = useToasts();
  const client = useMemo(
    () => createUsageActivityClient(owner, org),
    [owner, org],
  );
  useEffect(() => {
    let current = true;
    setReady(undefined);
    void setLocale(locale, { persist: false, document: false }).then(() => {
      if (current) setReady(locale);
    });
    return () => {
      current = false;
    };
  }, [locale]);
  const onError = useCallback(
    () =>
      toasts.addError(
        intl.formatMessage({
          defaultMessage:
            "There was an error submitting your request. Try again later.",
          id: "5iDKTQ",
        }),
      ),
    [toasts.addError, intl],
  );
  if (!owner || !org || ready !== locale) return null;
  return (
    <OfficialUsageActivity
      key={`${owner}:${org}`}
      client={client}
      onError={onError}
      refreshRevision={revision}
    />
  );
}
