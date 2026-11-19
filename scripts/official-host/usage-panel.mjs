import { ZecousMigration } from "./claudex-zecous-migration.js";
import { HostUsageActivity, useUsageLocale } from "./claudex-usage-activity.js";
import { GG as SettingsSection } from "./shared-1-B16QIYNI.js";
import {
  Ft as Dialog,
  tw as Button,
  uR as Skeleton,
} from "./shared-frame-DH1u5uQk.js";
import { lM as UsageMeter } from "./shared-19-DSOWNXOA.js";
import { t as Progress } from "./c17c9c40b-CQVGk63d.js";
import {
  l as useSpendAmount,
  u as useSpendAmountErrors,
} from "./c46e69531-Dm2LD2SA.js";
import { Vb as formatSpendAmount } from "./shared-l-0-DNyx6Bbt.js";
import { p as useIntl } from "./vendor-intl-D9Num-b5.js";
import {
  bo as useId,
  Do as useState,
  vo as useEffect,
  Eo as useRef,
  qa as jsx,
  Ja as jsxs,
} from "./vendor-frame-iz8L1jC9.js";
export function hasHostUsage(account, org) {
  const auth = account?.claudex_host_authentication,
    cap = account?.claudex_usage_summary;
  return (
    typeof account?.uuid === "string" &&
    account.uuid.length > 0 &&
    typeof org?.uuid === "string" &&
    org.uuid.length > 0 &&
    auth?.version === 1 &&
    auth.status === "authenticated" &&
    auth.account_uuid === account.uuid &&
    cap?.version === 1 &&
    cap.read_only === true &&
    cap.account_uuid === account.uuid &&
    cap.organization_uuid === org.uuid
  );
}
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const when = (n) =>
  n === null || (finite(n) && Number.isFinite(new Date(n).getTime()));
const nullableText = (n) => n === null || typeof n === "string";
export function validateUsageSummary(data, owner, org) {
  if (
    data?.version !== 1 ||
    data.account_uuid !== owner ||
    data.organization_uuid !== org ||
    data.currency !== "USD" ||
    typeof data.observed_at !== "string" ||
    !Number.isFinite(Date.parse(data.observed_at))
  )
    throw Error("Invalid summary");
  for (const key of ["billing", "plan_usage", "spend_limit"]) {
    const source = data[key];
    if (!["available", "unavailable", "error"].includes(source?.state))
      throw Error("Invalid source");
    if (source.state !== "available") continue;
    const d = source.data;
    if (!d || typeof d !== "object") throw Error("Missing source data");
    if (
      key === "billing" &&
      !(finite(d.balanceUsd) && nullableText(d.plan) && when(d.planExpiresAt))
    )
      throw Error("Invalid billing");
    if (
      key === "spend_limit" &&
      !(
        finite(d.usedUsd) &&
        (d.limitUsd === null || finite(d.limitUsd)) &&
        typeof d.resetsAt === "string" &&
        Number.isFinite(Date.parse(d.resetsAt))
      )
    )
      throw Error("Invalid spending");
    if (key === "plan_usage") {
      if (
        typeof d.plan !== "string" ||
        !when(d.expiresAt) ||
        !finite(d.updatedAt) ||
        !when(d.updatedAt) ||
        !Array.isArray(d.windows) ||
        d.windows.length > 256 ||
        (d.balanceUsd !== undefined &&
          d.balanceUsd !== null &&
          !finite(d.balanceUsd))
      )
        throw Error("Invalid usage");
      const ids = new Set();
      for (const w of d.windows) {
        if (
          !w ||
          typeof w.id !== "string" ||
          ids.has(w.id) ||
          typeof w.label !== "string" ||
          ![
            "session",
            "all_models",
            "models",
            "daily",
            "monthly",
            "key",
          ].includes(w.kind) ||
          !finite(w.usedUsd) ||
          !finite(w.limitUsd) ||
          !finite(w.percent) ||
          w.percent < 0 ||
          w.percent > 100 ||
          !when(w.resetsAt) ||
          (w.windowSeconds !== null && !finite(w.windowSeconds)) ||
          typeof w.active !== "boolean" ||
          typeof w.exceeded !== "boolean" ||
          !(
            w.models === null ||
            (Array.isArray(w.models) &&
              w.models.every((m) => typeof m === "string"))
          )
        )
          throw Error("Invalid window");
        ids.add(w.id);
      }
    }
  }
  return data;
}
export async function readUsageSummary(response) {
  if (!response.ok || !response.body) throw Error("Read unavailable");
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 600 * 1024) throw Error("Oversized summary");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text);
}
const maxSpendLimitCents = 10_000_000;
const formatSpendInput = (amount) =>
  formatSpendAmount(amount, "USD", {
    preferWholeNumber: true,
    locale: "en-US",
  });

function MonthlySpendLimit({ org, spend, canWrite, lease, locale, onSaved }) {
  const intl = useIntl();
  const helpId = useId();
  const [editor, setEditor] = useState(null);
  const request = useRef(null);
  const inputErrors = useSpendAmountErrors();
  const setAmount = (cents) => setEditor((draft) => ({ ...draft, cents }));
  const input = useSpendAmount({
    valueMinor: editor?.cents ?? null,
    onChangeMinor: setAmount,
    onEdit: () => {
      if (editor?.state === "failed")
        setEditor((draft) => ({ ...draft, state: "idle" }));
    },
    format: formatSpendInput,
  });
  useEffect(() => () => request.current?.abort(), []);

  const close = () => {
    input.reset();
    setEditor(null);
  };
  const onOpenChange = (open, event) => {
    if (request.current) {
      event.cancel();
      return;
    }
    if (open && canWrite) {
      setEditor({
        cents:
          spend.limitUsd === null ? 200_000 : Math.round(spend.limitUsd * 100),
        lease,
        state: "idle",
      });
    } else {
      close();
    }
  };
  const save = async (cents, state) => {
    if (!editor || !canWrite || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setEditor({ ...editor, state });
    try {
      const response = await fetch(
        "/api/organizations/" +
          encodeURIComponent(org) +
          "/overage_spend_limit",
        {
          method: "PUT",
          credentials: "same-origin",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(editor.lease
              ? { "x-claudex-spend-limit-activation": editor.lease }
              : {}),
          },
          body: JSON.stringify({
            monthly_credit_limit: cents,
            currency: "USD",
            period: "monthly",
          }),
        },
      );
      if (!response.ok) throw Error("Spend limit update failed");
      const saved = await response.json();
      if (
        saved?.organization_uuid !== org ||
        saved.currency !== "USD" ||
        saved.monthly_credit_limit !== cents
      )
        throw Error("Unexpected spend limit update");
      if (!controller.signal.aborted) {
        close();
        onSaved();
      }
    } catch {
      if (!controller.signal.aborted) setEditor({ ...editor, state: "failed" });
    } finally {
      request.current = null;
    }
  };
  const isPending = editor?.state === "limit" || editor?.state === "unlimited";
  const overLimit = editor?.cents > maxSpendLimitCents;
  const invalid = input.error !== null || overLimit;
  const message = (id, defaultMessage, values) =>
    intl.formatMessage({ id, defaultMessage }, values);
  const title = message("IUoTPQ", "Monthly spend limit");
  const used = locale.money(spend.usedUsd);
  const monthly =
    spend.limitUsd === null
      ? message("BXzJPr", "{used} this month · No spend limit", { used })
      : message("WxpSNC", "{used} of {limit} this month", {
          used,
          limit: formatSpendAmount(Math.round(spend.limitUsd * 100), "USD", {
            preferWholeNumber: true,
            locale: intl.locale,
            narrowSymbol: true,
          }),
        });
  const help = overLimit
    ? message("Ej2Qcx", "Maximum amount is {maxAmount}", {
        maxAmount: formatSpendInput(maxSpendLimitCents),
      })
    : input.error !== null
      ? inputErrors[input.error]
      : editor?.cents === 0
        ? message(
            "B19r4H",
            "Setting a limit to $0 effectively disables additional spend",
          )
        : message("OFSQyz", "This spend limit goes into effect immediately");

  return jsxs(Dialog.Root, {
    open: editor !== null,
    onOpenChange,
    disablePointerDismissal: isPending,
    children: [
      jsxs("div", {
        className: "flex items-start justify-between gap-lg",
        children: [
          jsxs("div", {
            className: "flex min-w-0 flex-col gap-xs",
            children: [
              jsx("h4", {
                className: "text-heading font-semibold text-primary",
                children: title,
              }),
              jsx("p", {
                className: "text-body text-secondary",
                children: monthly,
              }),
              jsx("p", {
                className: "text-footnote text-secondary",
                children: locale.text(
                  spend.limitUsd === null
                    ? "Usage is charged to your balance."
                    : "Usage is charged to your balance, up to this cap each month.",
                ),
              }),
              jsx("p", {
                className: "text-footnote text-secondary",
                children: `${locale.text("Resets")} ${locale.date(spend.resetsAt)}`,
              }),
            ],
          }),
          canWrite &&
            jsx(Dialog.Trigger, {
              render: jsx(Button, { variant: "ghost", size: "sm" }),
              children: message("rtbNQQ", "Manage"),
            }),
        ],
      }),
      jsxs(Dialog.Popup, {
        size: "md",
        children: [
          jsx(Dialog.Header, {
            showClose: !isPending,
            actions:
              isPending &&
              jsx(Dialog.CloseButton, { className: "invisible -me-pad-sm" }),
            description: message(
              "ttCKBZ",
              "You can set a maximum amount you can spend on Claudex usage per month.",
            ),
            children: message("XX5bYk", "Set monthly spend limit"),
          }),
          jsxs("div", {
            className: "flex flex-col gap-6",
            children: [
              jsxs("div", {
                children: [
                  jsx("input", {
                    type: "text",
                    inputMode: "decimal",
                    className:
                      "w-full px-3 py-2 bg-surface-3 border border-border-300 rounded-lg text-primary focus:outline-none focus:ring-2 focus:ring-neutral-50 focus:border-text-000",
                    ...input.inputProps,
                    disabled: isPending,
                    "aria-label": title,
                    "aria-invalid": invalid || undefined,
                    "aria-describedby": helpId,
                  }),
                  jsx("p", {
                    id: helpId,
                    className: `text-xs mt-3 ${invalid || editor?.cents === 0 ? "text-danger" : "text-secondary"}`,
                    children: help,
                  }),
                  editor?.state === "failed" &&
                    jsx("p", {
                      role: "alert",
                      className: "text-footnote text-danger mt-3",
                      children: message(
                        "5iDKTQ",
                        "There was an error submitting your request. Try again later.",
                      ),
                    }),
                ],
              }),
              jsxs(Dialog.Footer, {
                children: [
                  jsx(Button, {
                    variant: "secondary",
                    onClick: () => save(null, "unlimited"),
                    busy: editor?.state === "unlimited",
                    disabled: isPending,
                    children: message("nDe1hL", "Set to unlimited"),
                  }),
                  jsx(Button, {
                    variant: "primary",
                    onClick: () => save(editor.cents, "limit"),
                    busy: editor?.state === "limit",
                    disabled: !editor || isPending || invalid,
                    children: message("v3CYBV", "Set spend limit"),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}
export function HostUsagePanel({
  account,
  organization,
  view = "Usage",
  BillingRow,
  refreshBootstrap,
}) {
  const locale = useUsageLocale();
  const { locale: language } = useIntl();
  const owner = account?.uuid,
    org = organization?.uuid;
  const [revision, setRevision] = useState(0),
    [state, setState] = useState(null),
    epoch = useRef(0);
  useEffect(() => {
    const id = ++epoch.current,
      controller = new AbortController();
    setState({ owner, org, loading: true });
    if (!hasHostUsage(account, organization)) return () => controller.abort();
    const timeout = setTimeout(() => {
      if (epoch.current === id && !controller.signal.aborted) {
        setState({ owner, org, error: true });
        controller.abort();
      }
    }, 30000);
    (async () => {
      try {
        const response = await fetch(
          "/api/organizations/" +
            encodeURIComponent(org) +
            "/claudex_usage_summary" +
            (revision > 0 ? "?fresh=1" : ""),
          {
            signal: controller.signal,
            credentials: "same-origin",
            headers: { Accept: "application/json" },
          },
        );
        const data = validateUsageSummary(
          await readUsageSummary(response),
          owner,
          org,
        );
        if (!controller.signal.aborted && epoch.current === id)
          setState({ owner, org, data });
      } catch {
        if (!controller.signal.aborted && epoch.current === id)
          setState({ owner, org, error: true });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (epoch.current === id) epoch.current++;
    };
  }, [owner, org, revision]);
  const current = state?.owner === owner && state?.org === org ? state : null;
  const data = current?.data;
  if (!locale.ready) return jsx(Skeleton, { height: 80 });
  const { text: t, money, date } = locale;
  const refresh = jsx(Button, {
    variant: "secondary",
    size: "sm",
    disabled: current?.loading,
    onClick: () => setRevision((n) => n + 1),
    children: t("Refresh"),
  });
  const billingActions = view === "Billing" && typeof window !== "undefined" && typeof window.__claudexBilling === "function"
    ? jsxs("div", {
        className: "flex items-center gap-sm",
        children: [
          jsx(Button, {
            variant: "secondary",
            size: "sm",
            onClick: (event) => void window.__claudexBilling(event.currentTarget).catch(() => {}),
            children: language.startsWith("zh") ? "管理账单" : "Manage billing",
          }),
          refresh,
        ],
      })
    : refresh;
  const field = (label, value) =>
    jsxs("div", {
      className: "clx-usage-heading-row text-body",
      children: [
        jsx("span", { className: "text-secondary", children: t(label) }),
        jsx("span", {
          className: "text-primary tabular-nums",
          children: value,
        }),
      ],
    });
  const sourceSection = (title, source, render) =>
    jsx(SettingsSection, {
      title: t(title),
      children:
        source?.state === "available"
          ? render(source.data)
          : jsx("p", {
              className: "text-footnote text-secondary",
              role: source?.state === "error" ? "alert" : undefined,
              children: t(
                source?.state === "error"
                  ? "Usage could not be loaded."
                  : "Usage is unavailable.",
              ),
            }),
    });
  return jsxs("div", {
    className: "clx-usage-panel",
    children: [
      jsx("link", {
        rel: "stylesheet",
        href: "/assets/v1/claudex-usage-activity.css",
      }),
      jsx(SettingsSection, {
        title: t("Balance"),
        action: billingActions,
        children:
          !current || current.loading
            ? jsx("div", {
                role: "status",
                "aria-busy": true,
                "aria-label": t("Loading account usage"),
                children: jsx(Skeleton, { height: 80 }),
              })
            : current.error
              ? jsx("p", {
                  role: "alert",
                  className: "text-footnote text-secondary",
                  children: t(
                    "Usage could not be loaded. Check the connection and retry.",
                  ),
                })
              : data?.billing?.state === "available"
                ? jsxs("div", {
                    className: "flex flex-col gap-sm",
                    children: [
                      jsx("p", {
                        className:
                          "text-heading-semibold text-primary tabular-nums",
                        children: money(data.billing.data.balanceUsd),
                      }),
                      data.billing.data.plan !== null &&
                        field("Group", data.billing.data.plan),
                      data.billing.data.planExpiresAt !== null &&
                        field("Expires", date(data.billing.data.planExpiresAt)),
                    ],
                  })
                : jsx("p", {
                    role:
                      data?.billing?.state === "error" ? "alert" : undefined,
                    className: "text-footnote text-secondary",
                    children: t(
                      data?.billing?.state === "error"
                        ? "Usage could not be loaded."
                        : "Usage is unavailable.",
                    ),
                  }),
      }),
      view === "Billing" &&
        BillingRow &&
        account?.claudex_zecous_migration === true &&
        hasHostUsage(account, organization) &&
        jsx(
          ZecousMigration,
          {
            BillingRow,
            onTransferred: () => {
              setRevision((n) => n + 1);
              void refreshBootstrap({
                ambient: true,
                cancelRefetch: true,
              }).catch(() => {});
            },
          },
          owner + ":" + org,
        ),
      data &&
        sourceSection("Usage limits", data.plan_usage, (plan) =>
          jsx("div", {
            className: "flex flex-col gap-lg",
            children:
              plan.windows.length === 0
                ? jsx("p", {
                    className: "text-footnote text-secondary",
                    children: t("No usage limits are listed."),
                  })
                : plan.windows.map((window) =>
                    jsx(
                      UsageMeter,
                      {
                        name: jsx("span", {
                          className: "text-body text-primary",
                          title: window.models?.join(", "),
                          children: window.label,
                        }),
                        caption: [
                          window.resetsAt !== null
                            ? `${t("Resets")} ${date(window.resetsAt)}`
                            : "",
                          window.active ? "" : t("Inactive"),
                        ]
                          .filter(Boolean)
                          .join(" · "),
                        meter: jsx(Progress.Root, {
                          value: window.percent,
                          max: 100,
                          variant: window.exceeded ? "danger" : "accent",
                          "aria-label": window.label,
                          children: jsx(Progress.Track, {
                            children: jsx(Progress.Indicator, {}),
                          }),
                        }),
                        value: `${money(window.usedUsd)} / ${money(window.limitUsd)}`,
                      },
                      window.id,
                    ),
                  ),
          }),
        ),
      data &&
        (data.spend_limit.state === "available"
          ? jsx(SettingsSection, {
              children: jsx(
                MonthlySpendLimit,
                {
                  org,
                  spend: data.spend_limit.data,
                  canWrite: data.spend_limit_write === true,
                  lease: data.spend_limit_activation_lease,
                  locale,
                  onSaved: () => setRevision((n) => n + 1),
                },
                owner + ":" + org,
              ),
            })
          : sourceSection("Monthly spend limit", data.spend_limit)),
      view === "Usage" &&
        hasHostUsage(account, organization) &&
        jsx(
          HostUsageActivity,
          { account, organization, revision },
          owner + ":" + org,
        ),
    ],
  });
}
