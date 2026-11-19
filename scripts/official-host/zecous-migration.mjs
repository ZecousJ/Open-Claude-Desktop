import {
  GG as SettingsSection,
  cR as SettingsRow,
} from "./shared-1-B16QIYNI.js";
import { Ft as Dialog, tw as Button } from "./shared-frame-DH1u5uQk.js";
import { Vb as formatSpendAmount } from "./shared-l-0-DNyx6Bbt.js";
import { p as useIntl } from "./vendor-intl-D9Num-b5.js";
import {
  Do as useState,
  Eo as useRef,
  vo as useEffect,
  qa as jsx,
  Ja as jsxs,
} from "./vendor-frame-iz8L1jC9.js";

const migrationPath = "/api/claudex/zecous-migration";
const isAmount = (value) => Number.isFinite(value) && value >= 0;

async function readMigration(signal, path = "", method = "GET") {
  const response = await fetch(migrationPath + path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method,
    signal,
  });
  if (!response.ok) throw Error("ZecousAI migration request failed");
  const data = await response.json();
  if (data?.state === "none") return { state: "none" };
  if (
    !["pending", "done"].includes(data?.state) ||
    !isAmount(data.amountUsd) ||
    (data.state === "pending" &&
      !(isAmount(data.balanceUsd) && isAmount(data.subscriptionUsd)))
  ) {
    throw Error("Invalid ZecousAI migration status");
  }
  return data;
}

export function ZecousMigration({ BillingRow, onTransferred }) {
  const intl = useIntl();
  const [status, setStatus] = useState({ phase: "loading" });
  const [open, setOpen] = useState(false);
  const request = useRef(null);
  const chinese = intl.locale.toLowerCase().startsWith("zh");
  const label = (en, zh) => (chinese ? zh : en);
  const message = (id, en, zh) =>
    intl.formatMessage({ id, defaultMessage: label(en, zh) });
  const money = (amount) =>
    formatSpendAmount(amount * 100, "USD", {
      locale: intl.locale,
      narrowSymbol: true,
    });
  const setMigration = (data) => setStatus({ phase: data.state, data });

  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const data = await readMigration(controller.signal);
      if (!controller.signal.aborted) setMigration(data);
    } catch {
      if (!controller.signal.aborted) setStatus({ phase: "load-failed" });
    } finally {
      if (request.current === controller) request.current = null;
    }
  };
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, []);

  const confirm = async () => {
    if (
      request.current ||
      !["pending", "confirm-failed"].includes(status.phase)
    )
      return;
    const controller = new AbortController();
    const { signal } = controller;
    request.current = controller;
    setStatus({ phase: "confirming", data: status.data });
    try {
      let result;
      try {
        result = await readMigration(signal, "/confirm", "POST");
        if (result.state !== "done")
          throw Error("ZecousAI migration incomplete");
      } catch {
        if (signal.aborted) return;
        result = await readMigration(signal, "?refresh=1").catch(
          () => status.data,
        );
      }
      if (signal.aborted) return;
      if (result.state === "done") {
        setMigration(result);
        onTransferred();
      } else {
        setStatus({ phase: "confirm-failed", data: result });
      }
    } finally {
      request.current = null;
    }
  };

  const close = () => {
    setOpen(false);
    if (status.phase === "confirm-failed") setMigration(status.data);
  };
  const retry = message("FazwRldA7z", "Try again", "重试");
  const errorText = message(
    "5iDKTQ",
    "There was an error submitting your request. Try again later.",
    "提交请求时出错，请稍后重试。",
  );
  const brand = "ZecousAI";

  if (status.phase === "loading" || status.phase === "none") return null;
  if (status.phase === "load-failed") {
    return jsx(SettingsSection, {
      children: jsx(SettingsRow, {
        label: brand,
        description: jsx("span", {
          role: "alert",
          children: message("7R7rVY", "Couldn’t load balance", "无法加载余额"),
        }),
        control: jsx(Button, {
          variant: "secondary",
          onClick: load,
          children: retry,
        }),
      }),
    });
  }

  const { data } = status;
  const done = status.phase === "done";
  const busy = status.phase === "confirming";
  const failed = status.phase === "confirm-failed";
  const hasQuote = data.state !== "none";
  const hasBreakdown =
    isAmount(data.balanceUsd) &&
    isAmount(data.subscriptionUsd) &&
    (!done ||
      data.balanceUsd > 0 ||
      data.subscriptionUsd > 0 ||
      data.amountUsd === 0);
  const amount = hasQuote ? money(data.amountUsd) : undefined;
  const title = done
    ? label("ZecousAI balance transferred", "ZecousAI 余额已转移")
    : label("Transfer ZecousAI balance", "转移 ZecousAI 余额");
  const closeLabel = message("rbrahOGMC3", "Close", "关闭");
  const dismiss = jsx(Dialog.Close, {
    render: jsx(Button, {
      variant: done ? "primary" : "secondary",
      disabled: busy,
    }),
    children: done
      ? message("JXdbo8Vnlw", "Done", "完成")
      : hasQuote
        ? message("47FYwba+bI", "Cancel", "取消")
        : closeLabel,
  });

  return jsx(SettingsSection, {
    children: jsxs(Dialog.Root, {
      open,
      onOpenChange: (next, event) => {
        if (request.current) event.cancel();
        else if (next) setOpen(true);
        else close();
      },
      children: [
        jsx(SettingsRow, {
          label: title,
          description: amount,
          control: jsx(Dialog.Trigger, {
            render: jsx(Button, { variant: "secondary" }),
            children: message("MnpUD7", "View details", "查看详情"),
          }),
        }),
        jsxs(Dialog.Popup, {
          size: "md",
          children: [
            jsx(Dialog.Header, {
              showClose: !busy,
              closeLabel,
              description:
                !done && hasQuote
                  ? label(
                      "The value shown will be added to your Claudex balance.",
                      "所示金额将转入您的 Claudex 余额。",
                    )
                  : undefined,
              children: title,
            }),
            hasQuote &&
              jsxs("div", {
                className: "rounded-card border bg-surface-1",
                children: [
                  hasBreakdown &&
                    jsxs("div", {
                      className: "flex flex-col gap-2 px-4 py-3",
                      children: [
                        jsx(BillingRow, {
                          label: label("Balance", "余额"),
                          value: money(data.balanceUsd),
                        }),
                        jsx(BillingRow, {
                          label: label("Subscription value", "订阅折算金额"),
                          value: money(data.subscriptionUsd),
                        }),
                      ],
                    }),
                  jsx("div", {
                    className: hasBreakdown
                      ? "border-t border-border-300 px-4 py-3"
                      : "px-4 py-3",
                    children: jsx(BillingRow, {
                      label: done
                        ? label(
                            "Added to Claudex balance",
                            "已转入 Claudex 余额",
                          )
                        : label("To Claudex balance", "转入 Claudex 余额"),
                      value: amount,
                      emphasis: true,
                    }),
                  }),
                ],
              }),
            failed &&
              jsx("p", {
                className: "text-danger text-sm",
                role: "alert",
                children: errorText,
              }),
            jsxs(Dialog.Footer, {
              children: [
                dismiss,
                !done &&
                  hasQuote &&
                  jsx(Button, {
                    variant: "primary",
                    busy,
                    disabled: busy,
                    onClick: confirm,
                    children: failed
                      ? retry
                      : label("Confirm move", "确认转移"),
                  }),
              ],
            }),
          ],
        }),
      ],
    }),
  });
}
