import {
  Do as useState,
  Eo as useRef,
  Ja as jsxs,
  qa as jsx,
  vo as useEffect,
} from "./vendor-frame-iz8L1jC9.js";
import { p as useIntl } from "./vendor-intl-D9Num-b5.js";
import {
  BI as SegmentedControl,
  BO as Icon,
  Gd as Card,
  kT as Disclosure,
  tw as Button,
  uR as Skeleton,
} from "./shared-frame-DH1u5uQk.js";
import { t as ScheduledPage } from "./cd75b47e6-CviZ0ZTQ.js";
import { t as PageHeader } from "./cf35aed38-DldzGkLV.js";
import { l as StatusBanner } from "./ca4806d98-B_6RXrL8.js";
import { m as HealthMetric } from "./ca00fcdfd-B-Qw7-FD.js";
import {
  c as Table,
  f as TableHeader,
  h as TableRow,
  l as TableBody,
  p as TableHeading,
  u as TableCell,
} from "./c51c45b79-D677gebW.js";
import { CellChartContainer, Heatmap } from "./c469ccfa5-CvN4WhxT.js";

const windowHours = 24;
const stepMinutes = 10;
const refreshMs = 60_000;
const staleIqMs = 90 * refreshMs;
const current = { end: "", pagesBack: 0 };

const levels = {
  none: ["No samples", "Clock", "neutral", "var(--cds-alpha-2)"],
  operational: [
    "Operational",
    "CheckCircle",
    "positive",
    "var(--cds-fill-success)",
  ],
  degraded: [
    "Degraded performance",
    "Warning",
    "warning",
    "var(--cds-fill-warning)",
  ],
  outage: ["Outage", "XCircle", "danger", "var(--cds-fill-danger)"],
  stale: ["Stale samples", "Clock", "warning"],
};
const chartLevels = ["none", "operational", "degraded", "outage"];
const chartPalette = chartLevels.map((level) => ({
  paint: levels[level][3],
  forcedColors:
    "forced-colors:fill-[color:Canvas] forced-colors:stroke-[color:CanvasText]",
}));
const providers = {
  anthropic: "Anthropic",
  antigravity: "Antigravity",
  gemini: "Google",
  grok: "Grok",
  openai: "OpenAI",
};
const incidentStates = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};
const chinese = {
  "Service status": "服务状态",
  "Loading service status": "正在加载服务状态",
  "Service status is unavailable for this account.": "此账号无法查看服务状态。",
  "Couldn’t load service status.": "无法加载服务状态。",
  "Couldn’t refresh service status. Showing the last update.":
    "无法刷新服务状态，正在显示上次更新。",
  "Try again": "重试",
  Refresh: "刷新",
  "Current window": "当前时段",
  "Historical window": "历史时段",
  "Earlier 24 hours": "前 24 小时",
  "Later 24 hours": "后 24 小时",
  "Back to current": "回到当前",
  "Updated {time}": "更新于 {time}",
  "No samples": "无采样",
  "Stale samples": "采样已过期",
  Operational: "运行正常",
  "Degraded performance": "性能下降",
  Outage: "故障",
  "Services have an active incident": "存在进行中的服务事件",
  "No checks in this window": "此时段内没有检测",
  "No checks in the last hour": "最近一小时没有检测",
  "Some channels have no recent checks": "部分渠道最近没有检测",
  "Channel status": "渠道状态",
  "No channels are being monitored.": "目前没有监控渠道。",
  "Other providers": "其他服务商",
  "Window uptime": "时段可用率",
  "Last hour uptime": "最后一小时可用率",
  "Last hour of selected window": "所选时段的最后一小时",
  "Window checks": "时段检测",
  "{count} failed": "{count} 次失败",
  "Slow checks": "慢速检测",
  "Model checks": "模型检测",
  Model: "模型",
  Status: "状态",
  Checks: "检测",
  Failed: "失败",
  Uptime: "可用率",
  "10-minute samples for {channel}": "{channel} 的 10 分钟采样",
  "Active incidents": "进行中的事件",
  "Past incidents": "历史事件",
  "No active incidents.": "没有进行中的事件。",
  "No resolved incidents in this window.": "此时段内没有已解决的事件。",
  "All services": "所有服务",
  Investigating: "调查中",
  Identified: "已定位",
  Monitoring: "监控中",
  Resolved: "已解决",
  "Started {time}": "开始于 {time}",
  "Resolved {time}": "解决于 {time}",
  "GPT IQ check": "GPT 智商检测",
  "IQ check group": "智商检测分组",
  "Reference examples": "参考示例",
  Normal: "正常",
  "Dumbed down": "降智",
  "Latest check records": "最新检测记录",
  "No checks have been recorded for this group.": "此分组暂无检测记录。",
  "Latest attempt is more than 90 minutes old.": "最近一次检测已超过 90 分钟。",
  "No page this time": "这次没有生成页面",
  Succeeded: "成功",
  "Checked {time}": "检测于 {time}",
};

function labels(locale, timezone) {
  const messages = locale.toLowerCase().startsWith("zh") ? chinese : {};
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const time = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });
  const civil = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  return {
    t: (message, params = {}) =>
      (messages[message] ?? message).replace(
        /\{(\w+)\}/g,
        (_, key) => params[key],
      ),
    number: (value) => number.format(value),
    percent: (value) => (value === null ? "–" : percent.format(value / 100)),
    time: (value) => time.format(value),
    range: (from, to) => civil.formatRange(slot(from), slot(to)),
    slotRange: (date, step) =>
      civil.formatRange(slot(date), slot(addMinutes(date, step))),
  };
}

const slot = (value) => new Date(value + "Z");
const addMinutes = (date, minutes) =>
  new Date(Number(slot(date)) + minutes * 60_000).toISOString().slice(0, 16);
const countSamples = (days) => days.reduce((sum, day) => sum + day.checks, 0);
const levelOfUptime = (uptime) =>
  uptime >= 90 ? "operational" : uptime >= 80 ? "degraded" : "outage";

function sampleLevel(checks, recent, uptime, reported, historical) {
  if (!checks) return "none";
  if (!recent.checks && !historical) return "stale";
  return historical ? levelOfUptime(uptime) : reported;
}

function ExpandableCard({
  title,
  icon,
  description,
  defaultOpen = false,
  children,
}) {
  return jsx(Card, {
    children: jsxs(Disclosure.Root, {
      defaultOpen,
      children: [
        jsx(Disclosure.Trigger, {
          caretPosition: "end",
          className:
            "w-full items-start gap-sm text-start text-body-medium text-primary",
          children: jsxs("span", {
            className: "flex min-w-0 items-start gap-sm",
            children: [
              jsx(Icon, {
                name: icon,
                size: "sm",
                className: "shrink-0 text-secondary",
              }),
              jsxs("span", {
                className: "flex min-w-0 flex-col gap-xs",
                children: [
                  jsx("span", { children: title }),
                  description &&
                    jsx("span", {
                      className: "text-footnote font-normal text-secondary",
                      children: description,
                    }),
                ],
              }),
            ],
          }),
        }),
        jsx(Disclosure.Panel, {
          keepMounted: true,
          children: jsx("div", { className: "pt-md", children }),
        }),
      ],
    }),
  });
}

function Level({ level, text }) {
  const [label, icon, tone] = levels[level];
  const color = {
    neutral: "text-secondary",
    positive: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  };
  return jsxs("span", {
    className: "inline-flex items-center gap-xs",
    children: [
      jsx(Icon, { name: icon, size: "sm", className: color[tone] }),
      text.t(label),
    ],
  });
}

function SampleChart({ channel, step, incidents, text }) {
  const cells = channel.days.map((day, index) => ({
    x: index,
    y: 0,
    value: chartLevels.indexOf(day.level),
    label: text.slotRange(day.date, step),
    day,
  }));
  return jsx(CellChartContainer, {
    variant: "uncontained",
    tableView: false,
    label: text.t("10-minute samples for {channel}", { channel: channel.name }),
    cells,
    x: {
      format: (index) => text.slotRange(channel.days[index].date, step),
      tickFormat: (index) =>
        channel.days[index].date.slice(14) === "00"
          ? channel.days[index].date.slice(11)
          : "",
    },
    y: { format: () => "" },
    value: {
      categories: chartPalette,
      format: (value) => text.t(levels[chartLevels[value]][0]),
      details: ({ day }) => [
        ...(day.checks
          ? [
              { label: text.t("Uptime"), text: text.percent(day.uptime) },
              { label: text.t("Checks"), text: text.number(day.checks) },
              ...(day.degraded
                ? [
                    {
                      label: text.t("Slow checks"),
                      text: text.number(day.degraded),
                    },
                  ]
                : []),
              ...(day.failed
                ? [{ label: text.t("Failed"), text: text.number(day.failed) }]
                : []),
            ]
          : []),
        ...day.incidents.flatMap((id) => {
          const incident = incidents.get(id);
          return incident ? [{ label: "", text: incident.title }] : [];
        }),
      ],
    },
    children: jsx(Heatmap, {}),
  });
}

function ModelTable({ models, historical, text }) {
  return jsx("div", {
    className: "overflow-x-auto",
    children: jsxs(Table, {
      flush: false,
      "aria-label": text.t("Model checks"),
      children: [
        jsx(TableHeader, {
          children: jsx(TableRow, {
            children: [
              "Model",
              "Status",
              "Window uptime",
              "Checks",
              "Failed",
            ].map((header) =>
              jsx(
                TableHeading,
                { scope: "col", children: text.t(header) },
                header,
              ),
            ),
          }),
        }),
        jsx(TableBody, {
          children: models.map((model) => {
            const checks = countSamples(model.days);
            const level = sampleLevel(
              checks,
              model.recent,
              model.uptime,
              model.level,
              historical,
            );
            return jsxs(
              TableRow,
              {
                hoverable: false,
                children: [
                  jsx(TableCell, { children: model.name }),
                  jsx(TableCell, { children: jsx(Level, { level, text }) }),
                  jsx(TableCell, { children: text.percent(model.uptime) }),
                  jsx(TableCell, { children: text.number(checks) }),
                  jsx(TableCell, {
                    children: text.number(
                      model.days.reduce((sum, day) => sum + day.failed, 0),
                    ),
                  }),
                ],
              },
              `${model.monitorId}:${model.name}`,
            );
          }),
        }),
      ],
    }),
  });
}

function Channel({ channel, step, incidents, historical, text }) {
  const level = sampleLevel(
    channel.checks,
    channel.recent,
    channel.uptime,
    channel.level,
    historical,
  );
  const [label, icon, tone] = levels[level];
  return jsx(ExpandableCard, {
    title: channel.name,
    icon,
    description: text.t(label),
    defaultOpen: true,
    children: jsxs("div", {
      className: "flex flex-col gap-md",
      children: [
        jsxs("div", {
          className: "flex flex-wrap gap-md",
          children: [
            jsx(HealthMetric, {
              label: text.t("Window uptime"),
              value: text.percent(channel.uptime),
              tone,
            }),
            jsx(HealthMetric, {
              label: text.t("Last hour uptime"),
              value: text.percent(channel.recent.uptime),
              hint: historical
                ? text.t("Last hour of selected window")
                : undefined,
            }),
            jsx(HealthMetric, {
              label: text.t("Window checks"),
              value: text.number(channel.checks),
              hint: text.t("{count} failed", {
                count: text.number(channel.failed),
              }),
            }),
          ],
        }),
        jsx(SampleChart, { channel, step, incidents, text }),
        jsx(ModelTable, { models: channel.components, historical, text }),
      ],
    }),
  });
}

function Channels({ status, historical, text }) {
  const grouped = Map.groupBy(status.platforms, (channel) => channel.provider);
  const incidents = new Map(
    status.incidents.map((incident) => [incident.id, incident]),
  );
  return jsxs("section", {
    className: "flex flex-col gap-lg",
    "aria-labelledby": "claudex-channel-status",
    children: [
      jsx("h2", {
        id: "claudex-channel-status",
        className: "text-body font-medium text-primary",
        children: text.t("Channel status"),
      }),
      !grouped.size &&
        jsx(StatusBanner, {
          kind: "status",
          children: text.t("No channels are being monitored."),
        }),
      ...Array.from(grouped, ([provider, channels]) =>
        jsxs(
          "div",
          {
            className: "flex flex-col gap-sm",
            children: [
              jsx("h3", {
                className: "text-body font-medium text-primary",
                children:
                  (providers[provider] ?? provider) ||
                  text.t("Other providers"),
              }),
              ...channels.map((channel) =>
                jsx(
                  Channel,
                  {
                    channel,
                    step: status.stepMinutes,
                    incidents,
                    historical,
                    text,
                  },
                  channel.platform,
                ),
              ),
            ],
          },
          provider,
        ),
      ),
    ],
  });
}

function Incidents({ open, incidents, status, text }) {
  const title = text.t(open ? "Active incidents" : "Past incidents");
  const nameByKey = new Map(
    status.platforms.map((channel) => [channel.platform, channel.name]),
  );
  const id = open ? "claudex-active-incidents" : "claudex-past-incidents";
  return jsxs("section", {
    className: "flex min-w-0 flex-col gap-sm",
    "aria-labelledby": id,
    children: [
      jsx("h2", {
        id,
        className: "text-body font-medium text-primary",
        children: title,
      }),
      incidents.length
        ? jsx("ul", {
            role: "list",
            className: "flex flex-col gap-sm",
            children: incidents.map((incident) =>
              jsx(
                "li",
                {
                  children: jsx(ExpandableCard, {
                    title: incident.title,
                    icon: open ? levels[incident.impact][1] : "CheckCircle",
                    description: `${text.t(incidentStates[incident.status])} · ${incident.platform ? (nameByKey.get(incident.platform) ?? incident.platform) : text.t("All services")}`,
                    children: jsxs("div", {
                      className:
                        "flex flex-col gap-sm text-body text-secondary",
                      children: [
                        incident.startedAt > 0 &&
                          jsx("p", {
                            children: text.t("Started {time}", {
                              time: text.time(incident.startedAt),
                            }),
                          }),
                        !open &&
                          jsx("p", {
                            children: text.t("Resolved {time}", {
                              time: text.time(incident.resolvedAt),
                            }),
                          }),
                        incident.message &&
                          !incident.updates.length &&
                          jsx("p", {
                            className: "whitespace-pre-wrap",
                            children: incident.message,
                          }),
                        incident.updates.map((update, index) =>
                          jsxs(
                            "div",
                            {
                              className: "flex flex-col gap-xs",
                              children: [
                                jsx("p", {
                                  className:
                                    "text-footnote text-muted-as-secondary",
                                  children: [
                                    text.t(incidentStates[update.status]),
                                    update.at > 0 && text.time(update.at),
                                  ]
                                    .filter(Boolean)
                                    .join(" · "),
                                }),
                                update.message &&
                                  jsx("p", {
                                    className: "whitespace-pre-wrap",
                                    children: update.message,
                                  }),
                              ],
                            },
                            index,
                          ),
                        ),
                      ],
                    }),
                  }),
                },
                incident.id,
              ),
            ),
          })
        : jsx("p", {
            className: "text-body text-secondary",
            children: text.t(
              open
                ? "No active incidents."
                : "No resolved incidents in this window.",
            ),
          }),
    ],
  });
}

const previewWidth = 800;
const previewHeight = 600;

function Animation({ html, title }) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = box.current;
    const resize = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    const intersection = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    resize.observe(node);
    intersection.observe(node);
    return () => {
      resize.disconnect();
      intersection.disconnect();
    };
  }, []);
  return jsx("div", {
    ref: box,
    className: "relative overflow-hidden bg-surface-2",
    style: { aspectRatio: "4 / 3" },
    children:
      width > 0 &&
      visible &&
      jsx("iframe", {
        sandbox: "allow-scripts",
        title,
        src: "/official-status-preview.html",
        onLoad: ({ currentTarget }) => {
          currentTarget.contentWindow?.postMessage(html, "*");
        },
        tabIndex: -1,
        className: "absolute start-0 top-0 border-0",
        style: {
          width: previewWidth,
          height: previewHeight,
          transformOrigin: "top left",
          transform: `scale(${width / previewWidth})`,
        },
      }),
  });
}

function IQCard({ title, html, description, model, tone, text }) {
  const border =
    tone === "positive"
      ? "border-success"
      : tone === "danger"
        ? "border-danger"
        : undefined;
  return jsxs(Card, {
    role: "figure",
    className: border ? "border " + border : undefined,
    children: [
      jsx(Card.Media, {
        children: html
          ? jsx(Animation, {
              html,
              title: [title, description].filter(Boolean).join(" · "),
            })
          : jsx("div", {
              className:
                "flex items-center justify-center bg-surface-2 text-body text-secondary",
              style: { aspectRatio: "4 / 3" },
              children: text.t("No page this time"),
            }),
      }),
      jsxs("div", {
        className: "mt-2 -mb-2 flex min-w-0 flex-col gap-xs",
        children: [
          jsx("span", {
            className: "text-body font-medium text-primary",
            children: title,
          }),
          jsx("span", {
            className: "text-footnote text-secondary break-words",
            children: [model, description].filter(Boolean).join(" · "),
          }),
        ],
      }),
    ],
  });
}

function IQChecks({ status, text }) {
  const [selected, select] = useState("");
  const group =
    status.iqGroups.find(({ key }) => key === selected) ?? status.iqGroups[0];
  const checks = group?.checks ?? status.iq;
  const newest = checks.reduce(
    (time, check) => Math.max(time, check.startedAt),
    0,
  );
  const stale = newest > 0 && Date.now() - newest > staleIqMs;
  const grid = "grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3";
  return jsxs("section", {
    className: "flex flex-col gap-sm",
    "aria-labelledby": "claudex-iq-checks",
    children: [
      jsxs("div", {
        className: "flex flex-wrap items-center justify-between gap-sm",
        children: [
          jsx("h2", {
            id: "claudex-iq-checks",
            className: "text-body font-medium text-primary",
            children: text.t("GPT IQ check"),
          }),
          status.iqGroups.length > 1 &&
            jsx(SegmentedControl, {
              "aria-label": text.t("IQ check group"),
              segments: status.iqGroups.map(({ key, name }) => ({
                label: name,
                value: key,
              })),
              value: group.key,
              onChange: select,
            }),
        ],
      }),
      status.iqExamples.length > 0 &&
        jsxs("div", {
          className: "flex flex-col gap-sm",
          children: [
            jsx("h3", {
              className: "text-body font-medium text-primary",
              children: text.t("Reference examples"),
            }),
            jsx("div", {
              className: grid,
              children: status.iqExamples.map((example) =>
                jsx(
                  IQCard,
                  {
                    title: text.t(
                      example.kind === "normal" ? "Normal" : "Dumbed down",
                    ),
                    html: example.html,
                    model: example.model,
                    tone: example.kind === "normal" ? "positive" : "danger",
                    text,
                  },
                  example.kind,
                ),
              ),
            }),
          ],
        }),
      jsx("h3", {
        className: "text-body font-medium text-primary",
        children: text.t("Latest check records"),
      }),
      stale &&
        jsx(StatusBanner, {
          kind: "status",
          children: text.t("Latest attempt is more than 90 minutes old."),
        }),
      checks.length
        ? jsx("div", {
            className: grid,
            children: checks.map((check) =>
              jsx(
                IQCard,
                {
                  title: text.t(check.status === "ok" ? "Succeeded" : "Failed"),
                  description: text.t("Checked {time}", {
                    time: text.time(check.startedAt),
                  }),
                  model: check.model,
                  html: check.html,
                  text,
                },
                check.id,
              ),
            ),
          })
        : jsx("p", {
            className: "text-body text-secondary",
            children: text.t("No checks have been recorded for this group."),
          }),
    ],
  });
}

function WindowSummary({ report, pending, select, refresh, text }) {
  const { status, selection } = report;
  const historical = selection.pagesBack > 0;
  const open = status.incidents.filter(({ resolvedAt }) => resolvedAt === null);
  const checks = status.platforms.reduce(
    (sum, channel) => sum + channel.checks,
    0,
  );
  const recent = status.platforms.some((channel) => channel.recent.checks > 0);
  const missing =
    !historical &&
    status.platforms.some((channel) => channel.recent.checks === 0);
  const level = historical
    ? (["outage", "degraded", "operational"].find((level) =>
        status.platforms.some(
          (channel) =>
            channel.checks && levelOfUptime(channel.uptime) === level,
        ),
      ) ?? "none")
    : status.level;
  const headline =
    !historical && open.length
      ? "Services have an active incident"
      : !checks
        ? "No checks in this window"
        : !historical && !recent
          ? "No checks in the last hour"
          : missing && level === "operational"
            ? "Some channels have no recent checks"
            : levels[level][0];
  const clock =
    status.start && status.end
      ? text.range(status.start, addMinutes(status.end, status.stepMinutes)) +
        ` (${status.timezone})`
      : "";
  const previous = () =>
    select({
      end: addMinutes(status.start, -status.stepMinutes),
      pagesBack: selection.pagesBack + 1,
    });
  const next = () =>
    select(
      selection.pagesBack <= 1
        ? current
        : {
            end: addMinutes(status.end, windowHours * 60),
            pagesBack: selection.pagesBack - 1,
          },
    );
  const iconButton = (icon, label, onClick, disabled = pending) =>
    jsx(Button, {
      size: "sm",
      variant: "ghost",
      "aria-label": text.t(label),
      title: text.t(label),
      disabled,
      onClick,
      children: jsx(Icon, { name: icon, size: "sm" }),
    });

  return jsxs("div", {
    className: "flex flex-col gap-md",
    children: [
      jsx(StatusBanner, {
        kind:
          headline === "Outage" ||
          headline === "Services have an active incident"
            ? "error"
            : "status",
        children: text.t(headline),
      }),
      jsxs("div", {
        className: "flex flex-wrap items-center justify-between gap-sm",
        children: [
          jsxs("div", {
            className: "flex flex-col gap-xs",
            children: [
              jsx("h2", {
                className: "text-body font-medium text-primary",
                children: text.t(
                  historical ? "Historical window" : "Current window",
                ),
              }),
              jsx("div", {
                className: "text-footnote text-secondary",
                children: clock,
              }),
            ],
          }),
          jsxs("div", {
            className: "flex flex-wrap items-center gap-xs",
            children: [
              iconButton(
                "CaretLeft",
                "Earlier 24 hours",
                previous,
                pending || !clock,
              ),
              iconButton(
                "CaretRight",
                "Later 24 hours",
                next,
                pending || !historical || !clock,
              ),
              historical &&
                jsx(Button, {
                  size: "sm",
                  variant: "ghost",
                  disabled: pending,
                  onClick: () => select(current),
                  children: text.t("Back to current"),
                }),
              iconButton("ArrowClockwise", "Refresh", refresh),
            ],
          }),
        ],
      }),
      status.generatedAt > 0 &&
        jsx("div", {
          className: "text-footnote text-muted-as-secondary",
          children: text.t("Updated {time}", {
            time: text.time(status.generatedAt),
          }),
        }),
    ],
  });
}

export function HostServiceStatusPanel() {
  const { locale } = useIntl();
  const [selection, select] = useState(current);
  const [read, setRead] = useState({
    pending: true,
    report: null,
    failure: false,
    unavailable: false,
  });
  const [refreshes, setRefreshes] = useState(0);
  const refresh = () => setRefreshes((count) => count + 1);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const query = new URLSearchParams({
      hours: String(windowHours),
      step: String(stepMinutes),
    });
    if (selection.end) query.set("end", selection.end);
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      setRead((state) => ({ ...state, pending: true, failure: false }));
      try {
        const response = await fetch("/api/claudex/service-status?" + query, {
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw Error("Service status request failed");
        const status = await response.json();
        if (signal.aborted) return;
        setRead({
          pending: false,
          report: status ? { status, selection } : null,
          failure: false,
          unavailable: status === null,
        });
      } catch {
        if (!signal.aborted)
          setRead((state) => ({ ...state, pending: false, failure: true }));
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = selection.end ? undefined : setInterval(load, refreshMs);
    return () => {
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [selection, refreshes]);

  const { report, pending, failure, unavailable } = read;
  const text = labels(locale, report?.status.timezone || "UTC");
  const status = report?.status;
  const historical = !!report?.selection.pagesBack;
  return jsx("div", {
    className: "h-full overflow-y-auto",
    children: jsx(ScheduledPage, {
      header: false,
      banner: jsx(PageHeader, { title: text.t("Service status") }),
      contentGap: "lg",
      children: jsxs("div", {
        className: "flex flex-col gap-xl",
        "aria-busy": pending,
        children: [
          failure &&
            jsx(StatusBanner, {
              kind: "error",
              action: jsx(Button, {
                variant: "secondary",
                size: "sm",
                onClick: refresh,
                children: text.t("Try again"),
              }),
              children: text.t(
                report
                  ? "Couldn’t refresh service status. Showing the last update."
                  : "Couldn’t load service status.",
              ),
            }),
          !report &&
            pending &&
            jsx("div", {
              "aria-label": text.t("Loading service status"),
              children: jsx(Skeleton.Rows, { rows: 3 }),
            }),
          !report &&
            !pending &&
            !failure &&
            unavailable &&
            jsx(StatusBanner, {
              kind: "status",
              children: text.t(
                "Service status is unavailable for this account.",
              ),
            }),
          report &&
            jsx(WindowSummary, { report, pending, select, refresh, text }),
          status &&
            jsx(Incidents, {
              open: true,
              incidents: status.incidents.filter(
                ({ resolvedAt }) => resolvedAt === null,
              ),
              status,
              text,
            }),
          status && jsx(Channels, { status, historical, text }),
          status &&
            jsx(Incidents, {
              open: false,
              incidents: status.incidents.filter(
                ({ resolvedAt, startedAt }) =>
                  resolvedAt !== null &&
                  (!historical || inCivilWindow(startedAt, resolvedAt, status)),
              ),
              status,
              text,
            }),
          status && jsx(IQChecks, { status, text }),
        ],
      }),
    }),
  });
}

function inCivilWindow(startedAt, resolvedAt, status) {
  const time = new Intl.DateTimeFormat("sv-SE", {
    timeZone: status.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const civil = (instant) => time.format(instant).replace(" ", "T");
  return (
    civil(startedAt) < addMinutes(status.end, status.stepMinutes) &&
    civil(resolvedAt) >= status.start
  );
}
