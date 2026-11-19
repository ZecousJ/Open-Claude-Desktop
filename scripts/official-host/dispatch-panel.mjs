import {
  Do as useState,
  Eo as useRef,
  Ja as jsxs,
  qa as jsx,
  vo as useEffect,
} from "./vendor-frame-iz8L1jC9.js";
import { p as useIntl } from "./vendor-intl-D9Num-b5.js";
import {
  BO as Icon,
  E4 as Link,
  NB as Switch,
  Op as Menu,
  si as Density,
  tw as Button,
} from "./shared-frame-DH1u5uQk.js";
import { Ua as Markdown } from "./shared-12-Dk64PZOo.js";
import { h8 as TitleRow } from "./shared-4-Kt-jV-IU.js";
import {
  claudexElicitationForm as ElicitationForm,
  claudexElicitationLink as ElicitationLink,
} from "./cc32965c2-BNok1Xiq.js";
import { t as Composer } from "./c04e7453f-D61h2bUO.js";
import { t as QrCode } from "./c6e0920aa-CcuoRi-J.js";
import { n as PanelSection } from "./cc5a62f6f-YJSN8OYq.js";
import { t as ListPage } from "./cd75b47e6-CviZ0ZTQ.js";

const root = "/api/claudex/dispatch/";
const routinePath = "/epitaxy/scheduled";
const pollMs = 3000;
const empty = [];

function topNotifications() {
  const top = window.top;
  try {
    return top?.isSecureContext &&
      top.location.origin === window.location.origin
      ? top.Notification
      : undefined;
  } catch {
    return undefined;
  }
}
const localComputer = "This computer";
const modes = {
  chat: ["Chats", "Chat", "WTrOy3"],
  code: ["Code", "Code", "9SUDUx"],
};
const taskStates = {
  pending: ["Clock", "bg-alpha-1", "text-secondary", "Pending"],
  running: ["Spinner", "bg-alpha-1", "text-secondary", "Running"],
  needsInput: [
    "Hand",
    "bg-warning border-warning-000/30",
    "text-warning-100",
    "Needs attention",
  ],
  failed: ["X", "bg-danger border-danger-000/30", "text-danger", "Failed"],
  review: [
    "Eye",
    "bg-accent border-accent-000/30",
    "text-accent",
    "Ready for review",
  ],
  done: [
    "Check",
    "bg-success border-success-100/30",
    "text-success-100",
    "Done",
  ],
};

async function request(signal, action, input) {
  const response = await fetch(root + action, {
    signal,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(input === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(input) }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw Error(body?.error ?? `Request failed (${response.status}).`);
  return body;
}

function usePoll(read, apply, fail, dependencies) {
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer;
    async function poll() {
      try {
        const value = await read(signal);
        if (!signal.aborted) apply(value);
      } catch (error) {
        if (!signal.aborted) fail(error);
      } finally {
        if (!signal.aborted) timer = setTimeout(poll, pollMs);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, dependencies);
}

function Picker({ icon, label, value, items, disabled }) {
  return jsxs(Menu.Root, {
    children: [
      jsx(Menu.Trigger, {
        render: jsx(Button, {
          variant: "ghost",
          size: "sm",
          icon,
          disabled,
          tooltip: false,
          "aria-label": label,
          className: "min-w-0",
        }),
        children: jsxs("span", {
          className: "flex min-w-0 items-center gap-1.5",
          children: [
            jsx("span", {
              className: "max-w-40 truncate",
              children: value || label,
            }),
            jsx(Icon, { name: "CaretDown", size: "xs", className: "shrink-0" }),
          ],
        }),
      }),
      jsx(Density, {
        density: "compact",
        className: "contents",
        children: jsx(Menu.Popup, {
          align: "start",
          side: "bottom",
          children: items.map((item) =>
            jsx(
              Menu.Item,
              {
                icon: item.icon ?? icon,
                role: "menuitemradio",
                "aria-checked": item.selected,
                checked: item.selected,
                labelDir: "auto",
                onClick: item.select,
                trailing:
                  item.hint &&
                  jsx("span", {
                    className: "text-footnote text-muted-as-secondary",
                    children: item.hint,
                  }),
                children: item.label,
              },
              item.id,
            ),
          ),
        }),
      }),
    ],
  });
}

function Card({ title, action, children }) {
  return jsx(PanelSection, {
    title,
    titleAs: "h2",
    collapsible: false,
    isExpanded: true,
    headerLeftAction: action,
    className:
      "!border-0 !bg-surface-3 ![box-shadow:var(--df-shadow-card)] min-h-12",
    children,
  });
}

function Notice({ children, error = false }) {
  return jsx("div", {
    role: error ? "alert" : "status",
    className:
      "rounded-xl border-0.5 border-strong bg-alpha-1 px-3 py-2 text-sm text-secondary break-words",
    children,
  });
}

function TaskTile({ task, state, selected, open, children }) {
  const intl = useIntl();
  const [icon, tile, color, label] = taskStates[state];
  const mode = modes[task.mode === "cowork" ? "chat" : task.mode];
  const title = task.title || task.id;
  return jsxs("div", {
    className: `relative flex min-h-14 w-full shrink-0 items-center gap-2.5 rounded-2xl border-[0.5px] border-strong ps-3 pe-3.5 text-start transition-[background-color,border-color,box-shadow] ${selected || state !== "done" ? "bg-surface-3" : ""} ${open ? "hover:bg-surface-3 hover:shadow-[inset_0_0_0_0.5px_var(--cds-border-strong)]" : ""}`,
    children: [
      open &&
        jsx("button", {
          type: "button",
          onClick: open,
          "aria-label": title,
          "aria-current": selected || undefined,
          className: "can-focus absolute inset-0 rounded-2xl",
        }),
      jsx("span", {
        className: `pointer-events-none relative flex size-8 shrink-0 items-center justify-center rounded-lg border-[0.5px] ${tile}`,
        children: jsx(Icon, { name: icon, size: "sm", className: color }),
      }),
      jsxs("span", {
        className:
          "pointer-events-none relative flex min-w-0 flex-1 flex-col gap-0.5 py-1.5",
        children: [
          jsxs("span", {
            className: "flex min-w-0 items-baseline gap-2",
            children: [
              jsx("span", {
                className: "min-w-0 flex-1 truncate text-sm text-primary",
                dir: "auto",
                children: title,
              }),
              task.updatedAt &&
                jsx("time", {
                  className: "shrink-0 text-xs text-muted-as-secondary",
                  dateTime: new Date(task.updatedAt).toISOString(),
                  children: intl.formatDate(task.updatedAt, {
                    month: "short",
                    day: "numeric",
                  }),
                }),
            ],
          }),
          jsxs("span", {
            className:
              "flex min-w-0 items-center gap-1 text-xs text-muted-as-secondary",
            children: [
              mode &&
                jsx(Icon, { name: mode[0], size: "xs", className: "shrink-0" }),
              jsx("span", {
                className: task.error ? "break-words" : "truncate",
                children:
                  task.error ||
                  (task.cwd ? folderName(task.cwd) : null) ||
                  (mode
                    ? intl.formatMessage({
                        id: mode[2],
                        defaultMessage: mode[1],
                      })
                    : label),
              }),
              jsx("span", { className: "sr-only", children: label }),
            ],
          }),
        ],
      }),
      children,
    ],
  });
}

function TaskGroup({ title, children }) {
  if (!children.length) return null;
  return jsxs("section", {
    className: "flex flex-col gap-2",
    children: [
      jsx("h3", {
        className:
          "px-1 pt-2 text-[13px] leading-[1.4] text-muted-as-secondary",
        children: title,
      }),
      ...children,
    ],
  });
}

const folderName = (path) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function Setting({ icon, title, detail, children }) {
  return jsxs("div", {
    className:
      "flex w-full flex-wrap items-center gap-4 rounded-3xl border bg-surface-3 p-5 shadow-sm",
    children: [
      jsx(Icon, {
        name: icon,
        size: "md",
        className: "shrink-0 text-secondary",
      }),
      jsxs("div", {
        className: "flex min-w-0 flex-1 flex-col gap-1",
        children: [
          jsx("div", {
            className: "text-body-medium text-primary",
            children: title,
          }),
          detail &&
            jsx("div", {
              className: "break-words text-sm text-secondary",
              children: detail,
            }),
        ],
      }),
      children,
    ],
  });
}

function Setup({ status, receiving, busy, mutate, close, text }) {
  const trust = receiving?.trust;
  const pairing =
    receiving?.enabled && status?.local?.id && status.phoneLink
      ? new URL(status.phoneLink)
      : null;
  if (pairing) pairing.searchParams.set("device", status.local.id);
  return jsxs("section", {
    className: "mx-auto flex w-full max-w-md flex-col gap-5 px-3 py-4",
    children: [
      jsxs("div", {
        className: "flex flex-col items-center gap-3 py-3 text-center",
        children: [
          jsx(Icon, { name: "Dispatch", size: "lg" }),
          jsx("h2", {
            className: "font-heading text-center text-primary",
            children: text("9mZkFQ", "Get ready to dispatch"),
          }),
          jsx("p", {
            className: "text-center text-sm text-secondary",
            children: text(
              "59MmbP",
              "From your phone, you can hand Claude tasks that use everything on your desktop.",
            ),
          }),
        ],
      }),
      receiving &&
        jsx(Setting, {
          icon: "Laptop",
          title: "Control from your phone",
          children: jsx(Switch, {
            "aria-label": "Control from your phone",
            checked: receiving.enabled,
            disabled: busy,
            onCheckedChange: (enabled) => void mutate("receiving", { enabled }),
          }),
        }),
      pairing &&
        jsxs("div", {
          className: "flex flex-col items-center gap-2",
          children: [
            jsx(QrCode, {
              value: pairing.href,
              size: 176,
              includeMargin: true,
              title: text("VJXGlQ", "Pair your phone"),
            }),
            jsx(Button, {
              href: pairing.href,
              variant: "secondary",
              icon: "Phone",
              children: text("VJXGlQ", "Pair your phone"),
            }),
          ],
        }),
      receiving?.enabled &&
        jsxs("div", {
          className: "flex flex-col gap-3",
          children: [
            jsx(Setting, {
              icon: "Notification",
              title: text("BFYprP", "Mobile notifications"),
              children: jsx(Switch, {
                "aria-label": text("BFYprP", "Mobile notifications"),
                checked: receiving.notifications,
                disabled: busy,
                onCheckedChange: (notifications) =>
                  void mutate("receiving", { notifications }),
              }),
            }),
            jsx(Setting, {
              icon: "Folder",
              title: "Folders for your phone",
              children: jsx(Button, {
                variant: "secondary",
                size: "sm",
                disabled: busy,
                onClick: () => void mutate("add-directory", {}),
                children: "Add folder",
              }),
            }),
            ...receiving.folders.map((folder) =>
              jsx(
                Setting,
                {
                  icon: "Folder",
                  title: folderName(folder),
                  detail: folder,
                  children: jsx(Button, {
                    variant: "ghost",
                    size: "sm",
                    disabled: busy,
                    onClick: () => void mutate("remove-directory", { folder }),
                    children: "Remove",
                  }),
                },
                folder,
              ),
            ),
            trust &&
              jsxs("div", {
                className: "flex flex-col gap-2",
                children: [
                  jsx("h3", {
                    className: "text-body-medium text-primary",
                    children: "Device access",
                  }),
                  ...trust.trusted.map((device) =>
                    jsx(
                      Setting,
                      {
                        icon: "CheckCircle",
                        title: device.name,
                        detail: device.fingerprint,
                      },
                      device.id,
                    ),
                  ),
                  ...trust.pending.map((device) =>
                    jsx(
                      Setting,
                      {
                        icon: "Phone",
                        title: device.name,
                        detail: device.fingerprint,
                        children: jsxs("div", {
                          className: "flex flex-wrap justify-end gap-1.5",
                          children: ["reject", "approve"].map((action) =>
                            jsx(
                              Button,
                              {
                                size: "sm",
                                disabled: busy,
                                variant:
                                  action === "approve"
                                    ? "primary"
                                    : "secondary",
                                onClick: () =>
                                  void mutate("device-access", {
                                    id: device.id,
                                    fingerprint: device.fingerprint,
                                    action,
                                  }),
                                children:
                                  action === "approve" ? "Approve" : "Reject",
                              },
                              action,
                            ),
                          ),
                        }),
                      },
                      device.id,
                    ),
                  ),
                ],
              }),
          ],
        }),
      jsx(Button, {
        variant: "ghost",
        onClick: close,
        className: "self-center",
        children: text("h+3shD", "Done"),
      }),
    ],
  });
}

function Message({ text, user }) {
  return jsx("div", {
    className: `flex px-4 ${user ? "justify-end" : "justify-start"}`,
    children: jsx("div", {
      className: `min-w-0 max-w-[85%] rounded-3xl px-4 py-3 text-body-regular ${user ? "bg-alpha-2 text-primary" : "bg-surface-3 text-secondary shadow-sm [&_.standard-markdown]:gap-1.5"}`,
      children: user
        ? jsx("div", {
            className: "whitespace-pre-wrap break-words",
            dir: "auto",
            children: text,
          })
        : jsx(Markdown, { text, typography: "inherit" }),
    }),
  });
}

function Questions({ questions, answer, disabled, approvalId }) {
  const [values, setValues] = useState({});
  const [otherIds, setOtherIds] = useState(new Set());
  return jsxs("form", {
    className: "flex flex-col gap-3",
    onSubmit: (event) => {
      event.preventDefault();
      void answer({
        answers: Object.fromEntries(
          questions.map(({ id }) => [id, { answers: [values[id].trim()] }]),
        ),
      });
    },
    children: [
      ...questions.map((q) => {
        const onChange = (event) =>
          setValues({ ...values, [q.id]: event.target.value });
        const choices = q.isSecret ? null : q.options;
        const other = otherIds.has(q.id);
        const label = `dispatch-question-${approvalId}-${q.id}`;
        return jsxs(
          "div",
          {
            className: "flex flex-col gap-1.5 text-sm text-secondary",
            children: [
              jsx("label", { id: label, children: q.question }),
              choices?.length
                ? jsxs("select", {
                    disabled,
                    "aria-labelledby": label,
                    className:
                      "can-focus rounded-lg border border-strong bg-surface-2 p-2",
                    value: other ? "__other" : (values[q.id] ?? ""),
                    onChange: (event) => {
                      const selected = event.target.value;
                      const ids = new Set(otherIds);
                      if (selected === "__other") ids.add(q.id);
                      else ids.delete(q.id);
                      setOtherIds(ids);
                      setValues({
                        ...values,
                        [q.id]: selected === "__other" ? "" : selected,
                      });
                    },
                    children: [
                      jsx("option", {
                        value: "",
                        disabled: true,
                        children: "Choose an answer",
                      }),
                      ...choices.map((option) =>
                        jsx(
                          "option",
                          { value: option.label, children: option.label },
                          option.label,
                        ),
                      ),
                      q.isOther &&
                        jsx("option", { value: "__other", children: "Other" }),
                    ],
                  })
                : null,
              (!choices?.length || other) &&
                jsx("input", {
                  type: q.isSecret ? "password" : "text",
                  disabled,
                  "aria-labelledby": label,
                  className:
                    "can-focus rounded-lg border border-strong bg-surface-2 p-2",
                  value: values[q.id] ?? "",
                  onChange,
                }),
            ],
          },
          q.id,
        );
      }),
      jsx(Button, {
        type: "submit",
        variant: "primary",
        size: "sm",
        className: "self-end",
        disabled: disabled || questions.some(({ id }) => !values[id]?.trim()),
        children: "Submit",
      }),
    ],
  });
}

function Approval({ approval, conversation, disabled, answer }) {
  const { method, params = {} } = approval;
  const elicitation = method === "mcpServer/elicitation/request";
  const tool =
    elicitation && params._meta?.codex_approval_kind === "mcp_tool_call";
  if (elicitation && !tool) {
    const { mode, requestedSchema, serverName, message } = params;
    const decide = (_choice, _input, details) =>
      !disabled && answer(details.formResult).then(details.onAnswered);
    if (mode === "url") {
      let url;
      try {
        url = new URL(params.url);
      } catch {}
      if (url?.protocol === "https:" && !url.username && !url.password)
        return jsx(ElicitationLink, {
          armKey: String(approval.id),
          serverName,
          ask: {
            message,
            href: url.href,
            host: url.host,
            elicitationId: params.elicitationId,
          },
          decide,
        });
    } else if (requestedSchema?.type === "object" && requestedSchema.properties)
      return jsx(ElicitationForm, {
        armKey: String(approval.id),
        serverName,
        ask: { message, requestedSchema },
        decide,
      });
  }
  const question = method === "item/tool/requestUserInput";
  const canApprove =
    tool ||
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(method);
  const changed =
    method === "item/fileChange/requestApproval" &&
    conversation.turns
      .flatMap((turn) => turn.items)
      .find((item) => item.id === params.itemId)?.changes;
  const capability = params.permissions;
  const detail =
    params.command ||
    params.networkApprovalContext?.host ||
    (changed && changed.map((change) => change.path).join("\n")) ||
    params.grantRoot ||
    params.reason ||
    params.message;
  const title =
    {
      "item/commandExecution/requestApproval": params.networkApprovalContext
        ?.host
        ? "Allow Claude to connect?"
        : "Allow Claude to run this command?",
      "item/fileChange/requestApproval": "Allow Claude to edit files?",
      "item/permissions/requestApproval":
        "Allow Claude to use additional permissions?",
      "mcpServer/elicitation/request":
        params._meta?.tool_title ?? "Allow this connector action?",
    }[method] ?? "Claude is waiting for your input";
  return jsxs("div", {
    className:
      "flex flex-col gap-3 rounded-2xl border border-strong bg-surface-3 p-4",
    children: [
      jsx("h3", {
        className: "text-body-medium text-primary",
        children: title,
      }),
      detail &&
        jsx("div", {
          className: "whitespace-pre-wrap break-words text-sm text-secondary",
          children: detail,
        }),
      capability &&
        jsx("ul", {
          className: "list-disc ps-4 text-sm text-secondary",
          children: [
            ...(capability.network?.enabled ? ["Access the internet"] : []),
            ...(capability.fileSystem?.read ?? []).map(
              (path) => `Read: ${path}`,
            ),
            ...(capability.fileSystem?.write ?? []).map(
              (path) => `Write: ${path}`,
            ),
            ...(capability.fileSystem?.entries ?? []).map(
              (entry) =>
                `${entry.access}: ${entry.path?.path ?? entry.path?.pattern ?? entry.path?.value?.kind ?? ""}`,
            ),
          ].map((value, index) =>
            jsx("li", { className: "break-words", children: value }, index),
          ),
        }),
      question && params.questions?.length > 0
        ? jsx(Questions, {
            questions: params.questions,
            answer,
            disabled,
            approvalId: approval.id,
          })
        : canApprove &&
          jsxs("div", {
            className: "flex justify-end gap-2",
            children: [
              jsx(Button, {
                variant: "secondary",
                size: "sm",
                disabled,
                onClick: () => void answer({ choice: "deny" }),
                children: "Deny",
              }),
              jsx(Button, {
                variant: "primary",
                size: "sm",
                disabled,
                onClick: () => void answer({ choice: "once" }),
                children: "Allow once",
              }),
            ],
          }),
    ],
  });
}

function interruptTarget(conversation) {
  const turn = conversation?.turns.at(-1);
  if (turn?.status !== "inProgress") return;
  return {
    turnId: turn.id,
    turnCreatedAt: turn.createdAt,
    conversationCreatedAt: conversation.createdAt,
    ...(turn.id.startsWith("pending-")
      ? { kind: "starting" }
      : conversation.threadId
        ? { threadId: conversation.threadId }
        : {}),
  };
}

function Transcript({ detail, target, online, busy, mutate }) {
  const { conversation, approvals } = detail;
  return jsxs("div", {
    className: "flex flex-col gap-3",
    children: [
      ...conversation.turns.map((turn) =>
        jsxs(
          "div",
          {
            className: "flex flex-col gap-2",
            children: [
              turn.prompt && jsx(Message, { text: turn.prompt, user: true }),
              ...turn.items
                .filter((item) => item.type === "agentMessage" && item.text)
                .map((item) => jsx(Message, { text: item.text }, item.id)),
              turn.error && jsx(Notice, { error: true, children: turn.error }),
            ],
          },
          turn.id,
        ),
      ),
      ...approvals.map((approval) =>
        jsx(
          Approval,
          {
            approval,
            conversation,
            disabled: !online || busy,
            answer: (decision) =>
              mutate("approve", {
                ...target,
                approvalId: approval.id,
                decision,
              }).then((result) => result !== undefined),
          },
          approval.id,
        ),
      ),
    ],
  });
}

function Dispatch({ accountId, native }) {
  const intl = useIntl();
  const text = (id, defaultMessage) =>
    intl.formatMessage({ id, defaultMessage });
  const [requested] = useState(
    () => new URLSearchParams(window.location.search),
  );
  const [chosenDevice, chooseDevice] = useState(requested.get("device") || "");
  const [selected, setSelected] = useState(() => {
    const deviceId = requested.get("device");
    const conversationId = requested.get("task");
    return deviceId && conversationId ? { deviceId, conversationId } : null;
  });
  const [status, setStatus] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [folders, setFolders] = useState(null);
  const [detail, setDetail] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [refresh, recheck] = useState(0);
  const [mode, setMode] = useState("chat");
  const [chosenFolder, chooseFolder] = useState(null);
  const notifications = native ? undefined : topNotifications();
  const [permission, setPermission] = useState(notifications?.permission);
  const composerRef = useRef(null);
  const focusNew = useRef(false);
  const write = useRef(null);
  const controller = useRef(null);

  useEffect(() => {
    const mounted = new AbortController();
    controller.current = mounted;
    return () => mounted.abort();
  }, []);

  const recordError = (place, error) =>
    setErrors((prior) => ({ ...prior, [place]: error?.message ?? null }));
  usePoll(
    (signal) => request(signal, "status"),
    (value) => {
      setStatus(value);
      recordError("status", null);
    },
    (error) => recordError("status", error),
    [refresh],
  );
  usePoll(
    (signal) => (native ? request(signal, "receiving") : null),
    (value) => {
      setReceiving(value);
      recordError("receiving", null);
    },
    (error) => recordError("receiving", error),
    [native, refresh],
  );

  const devices = status?.devices ?? [];
  const local = status?.local;
  const deviceId =
    chosenDevice ||
    (native && receiving === null
      ? undefined
      : local && receiving?.enabled
        ? local.id
        : (devices.find((item) => status.onlineDeviceIds.includes(item.id))
            ?.id ?? devices[0]?.id));
  useEffect(() => {
    if (deviceId && !chosenDevice) chooseDevice(deviceId);
  }, [deviceId, chosenDevice]);
  const isLocal = !!deviceId && deviceId === local?.id;
  const device =
    devices.find(({ id }) => id === deviceId) ??
    (isLocal ? { id: local.id, name: localComputer } : undefined);
  const online =
    !!device &&
    (isLocal ? local.online : status.onlineDeviceIds.includes(device.id));
  const canQuery = !!device && (isLocal ? !!receiving?.enabled : online);
  const target = selected?.deviceId === deviceId ? selected : null;

  usePoll(
    (signal) => (canQuery ? request(signal, "tasks", { deviceId }) : null),
    (value) => {
      if (value) setTasks({ deviceId, value });
      recordError("tasks", null);
    },
    (error) => {
      setTasks(null);
      recordError("tasks", error);
    },
    [deviceId, canQuery, refresh],
  );
  usePoll(
    (signal) => (device ? request(signal, "directories", { deviceId }) : null),
    (value) => {
      if (value) setFolders({ deviceId, value });
      recordError("directories", null);
    },
    (error) => {
      setFolders(null);
      recordError("directories", error);
    },
    [deviceId, !!device, online, refresh],
  );
  usePoll(
    (signal) =>
      canQuery && target ? request(signal, "details", target) : null,
    (value) => {
      if (value) setDetail({ ...target, value });
      recordError("details", null);
    },
    (error) => {
      setDetail(null);
      recordError("details", error);
    },
    [target?.deviceId, target?.conversationId, canQuery, refresh],
  );

  const directories =
    folders?.deviceId === deviceId ? (folders?.value ?? empty) : empty;
  const folder =
    chosenFolder?.deviceId === deviceId
      ? directories.find(({ path }) => path === chosenFolder?.path)
      : (directories.find((candidate) => candidate.default) ?? directories[0]);
  const cwd = folder?.path;
  const currentDetail =
    target &&
    detail?.deviceId === target.deviceId &&
    detail?.conversationId === target.conversationId
      ? detail.value
      : null;
  const taskRows =
    tasks?.deviceId === deviceId ? (tasks?.value ?? empty) : empty;
  const deliveries = (status?.deliveries ?? []).filter(
    (item) => item.deviceId === deviceId,
  );
  const expected = interruptTarget(currentDetail?.conversation);
  const ready = !!device && (isLocal ? !!receiving?.enabled : true);
  const error = [
    errors.action,
    errors.details,
    errors.directories,
    errors.tasks,
    errors.status,
    errors.receiving,
  ].find(Boolean);
  const selectTask = (conversationId) => {
    setSelected(conversationId ? { deviceId, conversationId } : null);
    setErrors((prior) => ({ ...prior, action: null, details: null }));
  };
  useEffect(() => {
    if (!target && focusNew.current) {
      focusNew.current = false;
      composerRef.current?.querySelector("textarea")?.focus();
    }
  }, [target]);

  async function allowNotifications() {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    recordError("action", null);
    try {
      const result = await notifications.requestPermission();
      if (signal.aborted) return;
      setPermission(result);
      if (result !== "granted")
        recordError(
          "action",
          Error(
            result === "denied"
              ? "Notifications are blocked. Allow them in your browser or system settings, then try again."
              : "To turn this on, try again and allow notifications when your browser asks.",
          ),
        );
    } catch (error) {
      if (!signal.aborted) recordError("action", error);
    }
  }

  async function mutate(action, input, rethrow = false) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || write.current) {
      if (rethrow) throw Error("Wait for the current request to finish.");
      return;
    }
    const operation = request(signal, action, input);
    write.current = operation;
    setBusy(true);
    recordError("action", null);
    try {
      const result = await operation;
      if (signal.aborted) return;
      recheck((count) => count + 1);
      return result;
    } catch (error) {
      if (!signal.aborted) recordError("action", error);
      if (rethrow) throw error;
    } finally {
      if (write.current === operation) write.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }

  async function submit(content) {
    const result = target
      ? await mutate("follow-up", { ...target, text: content }, true)
      : await mutate("deliver", { deviceId, cwd, text: content, mode: mode === "chat" ? "cowork" : mode }, true);
    if (result?.state === "failed" || result?.state === "unknown") {
      const error = Error(result.error);
      recordError("action", error);
      throw error;
    }
  }

  const options =
    local && receiving?.enabled && !devices.some(({ id }) => id === local.id)
      ? [{ id: local.id, name: localComputer }, ...devices]
      : devices;
  const header = jsx("div", {
    className: "flex min-w-0 flex-wrap items-center justify-end gap-1",
    children: jsxs(Density, {
      density: "compact",
      className: "contents",
      children: [
        options.length > 0 &&
          jsx(Picker, {
            icon: "Laptop",
            label: "Desktop",
            value: device?.name,
            disabled: busy,
            items: options.map(({ id, name }) => ({
              id,
              label: id === local?.id ? localComputer : name,
              hint: (
                id === local?.id
                  ? local.online
                  : status?.onlineDeviceIds.includes(id)
              )
                ? undefined
                : text("K3uH1C", "offline"),
              selected: id === deviceId,
              select: () => {
                chooseDevice(id);
                if (id !== deviceId) {
                  setSelected(null);
                  setTasks(null);
                  setFolders(null);
                  setDetail(null);
                  setErrors({});
                }
              },
            })),
          }),
        permission === "default" &&
          device &&
          jsx(Button, {
            variant: "ghost",
            size: "sm",
            iconOnly: true,
            icon: "Notification",
            "aria-label": text("BFYprP", "Mobile notifications"),
            onClick: () => void allowNotifications(),
          }),
        native &&
          jsx(Button, {
            variant: "ghost",
            size: "sm",
            iconOnly: true,
            icon: "Settings",
            "aria-label": text("jqhhMI", "Settings"),
            pressed: showSetup,
            onClick: () => setShowSetup(!showSetup),
          }),
      ],
    }),
  });
  const composer =
    ready &&
    (!target || currentDetail) &&
    jsxs("div", {
      className: "shrink-0",
      children: [
        !target &&
          jsxs("div", {
            className: "flex min-w-0 flex-wrap items-center gap-1 px-3 pb-1",
            children: [
              jsx(Picker, {
                icon: modes[mode][0],
                label: "Task type",
                disabled: busy,
                value: text(modes[mode][2], modes[mode][1]),
                items: Object.entries(modes).map(
                  ([id, [icon, label, messageId]]) => ({
                    id,
                    icon,
                    label: text(messageId, label),
                    selected: id === mode,
                    select: () => setMode(id),
                  }),
                ),
              }),
              directories.length > 0
                ? jsx(Picker, {
                    icon: "Folder",
                    label: text("jOJqwS", "Select folder"),
                    disabled: busy,
                    value: folder?.name,
                    items: directories.map(({ path, name }) => ({
                      id: path,
                      label: name,
                      hint: path,
                      selected: path === cwd,
                      select: () => chooseFolder({ deviceId, path }),
                    })),
                  })
                : jsx("p", {
                    className: "px-2 text-footnote text-secondary",
                    children:
                      folders?.deviceId === deviceId
                        ? "No folders available for Remote Control."
                        : null,
                  }),
            ],
          }),
        jsx(Composer, {
          key: `${deviceId}:${target?.conversationId ?? "new"}`,
          draftKey: `claudex-dispatch:${accountId}:${deviceId}:${target?.conversationId ?? "new"}`,
          placeholder: text("XfP/Hb", "Ask Claude anything"),
          disabled:
            busy ||
            !!errors.status ||
            (target
              ? online && !!errors.details
              : !cwd || !!errors.directories),
          onSubmit: submit,
          maxLength: 100_000,
        }),
      ],
    });
  const taskList = [
    [
      "Active",
      taskRows.filter(
        (task) =>
          !task.approvals && !task.failed && (task.running || task.readyReview),
      ),
    ],
    [
      "Needs attention",
      taskRows.filter((task) => task.approvals || task.failed),
    ],
    [
      "Done",
      taskRows.filter(
        (task) =>
          !task.approvals && !task.failed && !task.running && !task.readyReview,
      ),
    ],
  ];
  const openRow = (task) =>
    jsx(
      TaskTile,
      {
        task,
        state: task.approvals
          ? "needsInput"
          : task.failed
            ? "failed"
            : task.running
              ? "running"
              : task.readyReview
                ? "review"
                : "done",
        selected: target?.conversationId === task.id,
        open: () => selectTask(task.id),
      },
      task.id,
    );
  const deliveryRow = (delivery) => {
    const { id, state, conversationId } = delivery;
    const open =
      conversationId && !taskRows.some((task) => task.id === conversationId)
        ? () => selectTask(conversationId)
        : null;
    if (state === "delivered" && !open) return null;
    return jsx(
      TaskTile,
      {
        task: delivery,
        state:
          state === "delivered"
            ? "done"
            : state === "pending"
              ? "pending"
              : "failed",
        open,
        children:
          state !== "pending" &&
          jsxs("div", {
            className: "relative flex shrink-0 gap-1",
            children: [
              state === "failed" &&
                jsx(Button, {
                  variant: "ghost",
                  size: "xs",
                  disabled: busy,
                  onClick: () => void mutate("retry", { id }),
                  children: text("62nsdyMyIO", "Retry"),
                }),
              jsx(Button, {
                variant: "ghost",
                size: "xs",
                iconOnly: true,
                icon: "X",
                "aria-label": "Dismiss delivery",
                disabled: busy,
                onClick: () => void mutate("remove", { id }),
              }),
            ],
          }),
      },
      id,
    );
  };
  const rail = jsx("aside", {
    "data-testid": "dispatch-tasks",
    className: `min-w-0 shrink-0 lg:w-80 ${target ? "hidden lg:block" : ""}`,
    children: jsx(Card, {
      title: text("yhU1et", "Tasks"),
      action: jsx(Link, {
        href: routinePath,
        className: "text-xs",
        children: text("Dbc6Xa", "Routines"),
      }),
      children: jsxs("div", {
        className:
          "flex max-h-[60vh] min-w-0 flex-col gap-2 overflow-y-auto pb-3 pt-2",
        children: [
          ready &&
            jsx(Button, {
              icon: "Add",
              variant: "ghost",
              size: "sm",
              className: "self-start",
              onClick: () => {
                if (target) {
                  focusNew.current = true;
                  selectTask(null);
                } else composerRef.current?.querySelector("textarea")?.focus();
              },
              children: "New task",
            }),
          jsx(TaskGroup, {
            title: "Pending",
            children: deliveries
              .filter((item) => item.state === "pending")
              .map(deliveryRow),
          }),
          jsx(TaskGroup, {
            title: "Delivery status",
            children: deliveries
              .filter(
                (item) => item.state === "failed" || item.state === "unknown",
              )
              .map(deliveryRow),
          }),
          ...taskList.map(([title, entries]) =>
            jsx(
              TaskGroup,
              {
                title,
                children: [
                  ...entries.map(openRow),
                  ...(title === "Done"
                    ? deliveries
                        .filter((item) => item.state === "delivered")
                        .map(deliveryRow)
                        .filter(Boolean)
                    : []),
                ],
              },
              title,
            ),
          ),
          !taskRows.length &&
            !deliveries.length &&
            jsx("p", {
              className:
                "px-1 py-6 text-center text-sm text-muted-as-secondary",
              children: status
                ? text("ZXH44s", "No tasks yet")
                : text("gjBiyj", "Loading..."),
            }),
        ],
      }),
    }),
  });

  return jsxs("div", {
    className: "relative h-full overflow-y-auto",
    "data-testid": "claudex-dispatch",
    children: [
      jsx(TitleRow, {
        hideGradient: true,
        style: { "--df-pane-trailing-gutter": "8px" },
        trailing: header,
        children: jsx("h1", {
          className:
            "text-body-medium truncate text-primary [[data-title-row-ruled]_&]:ps-1",
          children: text("MIchTR1xRO", "Dispatch"),
        }),
      }),
      jsx(ListPage, {
        header: false,
        width: "wide",
        contentGap: "lg",
        children: jsxs("div", {
          className: "flex min-w-0 flex-col gap-3 pb-3 pt-12",
          children: [
            error &&
              jsxs(Notice, {
                error: true,
                children: [
                  error,
                  errors.status &&
                    jsx(Button, {
                      variant: "ghost",
                      size: "sm",
                      onClick: () => recheck((count) => count + 1),
                      children: text("62nsdyMyIO", "Retry"),
                    }),
                ],
              }),
            showSetup && native
              ? jsx(Setup, {
                  status,
                  receiving,
                  busy,
                  mutate,
                  text,
                  close: () => setShowSetup(false),
                })
              : jsxs("div", {
                  className:
                    "flex min-w-0 flex-col gap-4 lg:min-h-[600px] lg:flex-row",
                  children: [
                    jsxs("section", {
                      className: "flex min-w-0 flex-1 flex-col gap-3",
                      children: [
                        target &&
                          jsxs("div", {
                            className: "flex min-w-0 items-center gap-2",
                            children: [
                              jsx(Button, {
                                variant: "ghost",
                                size: "sm",
                                iconOnly: true,
                                icon: "ArrowLeft",
                                "aria-label": text("cyR7KhiuaU", "Back"),
                                onClick: () => selectTask(null),
                              }),
                              jsx("h2", {
                                className:
                                  "min-w-0 flex-1 truncate text-body-medium text-primary",
                                children:
                                  currentDetail?.conversation.title ??
                                  taskRows.find(
                                    ({ id }) => id === target.conversationId,
                                  )?.title,
                              }),
                              expected &&
                                jsx(Button, {
                                  variant: "secondary",
                                  size: "sm",
                                  icon: "Stop",
                                  disabled: !online || !!errors.details || busy,
                                  onClick: () =>
                                    void mutate("interrupt", {
                                      ...target,
                                      expected,
                                    }),
                                  children: "Stop",
                                }),
                            ],
                          }),
                        device &&
                          !online &&
                          !isLocal &&
                          jsx(Notice, {
                            children: jsxs("div", {
                              className: "flex flex-col gap-0.5",
                              children: [
                                text("NNApjh", "Desktop appears offline."),
                                cwd &&
                                  jsx("span", {
                                    className:
                                      "text-xs text-muted-as-secondary",
                                    children: text(
                                      "fc7Q5U",
                                      "Will run when it reconnects.",
                                    ),
                                  }),
                              ],
                            }),
                          }),
                        isLocal &&
                          local.cause === "sign_in" &&
                          jsx(Notice, {
                            children: text(
                              "veGvlg",
                              "Your sign-in session has expired, so Dispatch is disconnected on this device. Sign in again to reconnect.",
                            ),
                          }),
                        status?.machinesFailed &&
                          jsx(Notice, {
                            error: true,
                            children: "Couldn't refresh available computers.",
                          }),
                        status &&
                          !ready &&
                          jsxs("div", {
                            className:
                              "flex min-h-48 flex-col items-center justify-center gap-4 px-4 text-center",
                            children: [
                              jsx(Icon, { name: "Dispatch", size: "lg" }),
                              jsx("h2", {
                                className: "font-heading text-primary",
                                children: native
                                  ? text("L88xAU", "Dispatch from anywhere")
                                  : "No computers connected",
                              }),
                              jsx("p", {
                                className: "text-sm text-secondary",
                                children: native
                                  ? text(
                                      "59MmbP",
                                      "From your phone, you can hand Claude tasks that use everything on your desktop.",
                                    )
                                  : "Turn on Remote Control in Claudex on your computer.",
                              }),
                              native &&
                                jsx(Button, {
                                  variant: "primary",
                                  size: "sm",
                                  children: "Set up Remote Control",
                                  onClick: () => setShowSetup(true),
                                }),
                            ],
                          }),
                        device &&
                          !isLocal &&
                          online &&
                          !!status?.pairedDeviceIds &&
                          !status.pairedDeviceIds.includes(deviceId) &&
                          jsx(Button, {
                            variant: "secondary",
                            size: "sm",
                            className: "self-start",
                            disabled: busy,
                            onClick: () => void mutate("trust", { deviceId }),
                            children: "Request device access",
                          }),
                        currentDetail &&
                          jsx("div", {
                            className: "flex min-h-20 flex-col gap-3 py-2",
                            children: jsx(Transcript, {
                              detail: currentDetail,
                              target,
                              online: online && !errors.details,
                              busy,
                              mutate,
                            }),
                          }),
                        target &&
                          !currentDetail &&
                          canQuery &&
                          !errors.details &&
                          jsx("p", {
                            className: "text-sm text-muted-as-secondary",
                            children: text("gjBiyj", "Loading..."),
                          }),
                        composer &&
                          jsx("div", {
                            "data-testid": "dispatch-composer",
                            className: "mt-auto",
                            ref: composerRef,
                            children: composer,
                          }),
                      ],
                    }),
                    rail,
                  ],
                }),
          ],
        }),
      }),
    ],
  });
}

export function HostDispatchPanel({ accountId, native }) {
  return jsx(Dispatch, { accountId, native }, accountId);
}
