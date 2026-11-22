import {
  Do as useState,
  Eo as useRef,
  Ja as jsxs,
  qa as jsx,
  vo as useEffect,
} from "./vendor-frame-iz8L1jC9.js";
import { l as Message, p as useIntl } from "./vendor-intl-D9Num-b5.js";
import {
  Ac as Tooltip,
  BO as Icon,
  E9 as ConfirmDialog,
  Ft as Dialog,
  Op as Menu,
  Qm as Select,
  ah as Banner,
  eS as TextField,
  tw as Button,
  uR as Skeleton,
} from "./shared-frame-DH1u5uQk.js";
import {
  GG as SettingsSection,
  MD as SettingsNest,
  cR as SettingsRow,
} from "./shared-1-B16QIYNI.js";
import { oS as useNotices } from "./shared-l-p-m-w-2-BMCa56Vr.js";
import { t as ScheduledPage } from "./cd75b47e6-CviZ0ZTQ.js";
import { t as PageHeader } from "./cf35aed38-DldzGkLV.js";
import { n as Card } from "./cbb0b7045-DDrVn_Qs.js";
import { i as EmptyRow, n as KeysTable } from "./cc02a252c-BWhVikhs.js";

const prefix = "/api/claudex/api-management/";
const noValue = "–";
const cardGrid = "grid auto-rows-fr grid-cols-1 gap-3 md:grid-cols-2 md:gap-6";
const vendorMarks = new Set([
  "openai",
  "xai",
  "anthropic",
  "gemini",
  "qwen",
  "deepseek",
]);
const emptyRead = { value: undefined, error: "", pending: true };

function ApiBalance({ balance, onReload }) {
  const intl = useIntl();
  const amount = balance.value?.balance;
  return jsx(SettingsSection, {
    title: message("Balance", "claudex-api-balance"),
    children: Number.isFinite(amount)
      ? jsx("span", {
          className: "text-heading-semibold text-primary tabular-nums",
          children: intl.formatNumber(amount, { style: "currency", currency: "USD" }),
        })
      : balance.error
        ? jsx(Failure, { retry: onReload, children: balance.error })
        : jsx(Skeleton, { width: 88, height: 24 }),
  });
}
const keyNameLimit = 100;
const keyStatus = {
  inactive: "Disabled",
  expired: "Expired",
  exhausted: "Quota used up",
};
const verificationErrors = {
  challenge_locked: [
    "Too many attempts. Close this and try again later.",
    "claudex-api-verify-locked",
  ],
  challenge_rate_limited: [
    "Another code can’t be sent yet. Wait for the timer or use the latest code.",
    "claudex-api-verify-rate",
  ],
  no_email_address: [
    "This account has no email address for a confirmation code.",
    "claudex-api-verify-no-email",
  ],
  code_not_sent: [
    "Couldn’t send the email. Try again in a moment.",
    "claudex-api-verify-send-failed",
  ],
  invalid_code: ["That code didn’t match.", "claudex-api-verify-invalid"],
  unavailable: [
    "Confirmation isn’t available right now. Try again in a moment.",
    "claudex-api-verify-unavailable",
  ],
};

class ApiError extends Error {
  constructor(status, detail) {
    super(detail?.message || "API management is unavailable.");
    this.status = status;
    this.code = detail?.code;
    this.actionLabel = detail?.actionLabel;
    this.seconds = detail?.seconds;
  }
}

async function request(path, signal, method = "GET", data) {
  signal.throwIfAborted();
  const response = await fetch(prefix + path, {
    signal,
    method,
    cache: "no-store",
    ...(data === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  const result =
    response.status === 204
      ? undefined
      : await response.json().catch((error) => {
          if (response.ok) throw error;
        });
  signal.throwIfAborted();
  if (!response.ok) throw new ApiError(response.status, result?.error);
  return result;
}

const interrupted = (error) => error?.name === "AbortError";
const formatRate = (value) =>
  value === undefined ? undefined : `${Number(value.toFixed(4))}x`;
const errorText = (error) =>
  error instanceof ApiError ? error.message : "The request failed. Try again.";

function message(defaultMessage, id, values) {
  return jsx(Message, { defaultMessage, id, values });
}

function Failure({ children, retry }) {
  return jsx(Banner, {
    variant: "danger",
    role: "alert",
    action:
      retry &&
      jsx(Button, {
        size: "sm",
        variant: "secondary",
        onClick: retry,
        children: message("Try again", "claudex-api-retry"),
      }),
    children,
  });
}

function ModelMenu({ models, modelCount, onCopy }) {
  const intl = useIntl();
  const label = intl.formatMessage(
    {
      defaultMessage: "{count, plural, one {# model} other {# models}}",
      id: "claudex-api-model-count",
    },
    { count: modelCount },
  );
  if (!models.length)
    return jsx("span", {
      className: "text-footnote text-secondary whitespace-nowrap",
      children: label,
    });
  return jsxs(Menu.Root, {
    children: [
      jsx(Menu.TriggerButton, {
        variant: "ghost",
        size: "sm",
        className: "shrink-0",
        children: label,
      }),
      jsx(Menu.SearchablePopup, {
        "data-size": "sm",
        className: "max-h-[min(50vh,var(--available-height))]",
        searchLabel: intl.formatMessage({
          defaultMessage: "Search models",
          id: "4mzlmb",
        }),
        children: (query) => {
          const matches = models.filter(
            (model) =>
              model.name.toLowerCase().includes(query) ||
              model.id.toLowerCase().includes(query),
          );
          return matches.length
            ? matches.map((model) =>
                jsx(
                  Menu.Item,
                  {
                    label: model.name,
                    description: model.name === model.id ? undefined : model.id,
                    icon: "Copy",
                    onClick: () => onCopy(model.id),
                    children: model.name,
                  },
                  model.id,
                ),
              )
            : jsx(Menu.Item, {
                disabled: true,
                children: message(
                  "No models found",
                  "claudex-api-no-model-matches",
                ),
              });
        },
      }),
    ],
  });
}

function ModelRow({ leading, label, rate, count, select }) {
  return jsx("li", {
    className: "px-4",
    children: jsx(SettingsRow, {
      className: "claudex-api-model-row",
      leading,
      label,
      labelAdornment:
        rate !== undefined &&
        jsx("span", {
          className:
            "text-footnote text-secondary whitespace-nowrap tabular-nums",
          children: rate,
        }),
      control: jsxs("div", {
        className: "flex min-w-0 items-center justify-end gap-xs",
        children: [count, select],
      }),
    }),
  });
}

function ModelRowsSkeleton() {
  return jsx(SettingsNest, {
    padding: "none",
    children: jsx("ul", {
      className: "divide-y divide-alpha-1",
      "aria-hidden": true,
      children: [0, 1, 2].map((index) => jsx(ModelRow, {
        leading: jsx(Skeleton, { width: 20, height: 20 }),
        label: jsx(Skeleton, { width: 72, height: 16 }),
        count: jsx(Skeleton, { width: 64, height: 20 }),
        select: jsx(Skeleton, { width: 144, height: 32 }),
      }, index)),
    }),
  });
}

function ProviderRow({ provider, rates, pending, onSelect, onCopy }) {
  const intl = useIntl();
  const group = provider.groups.find((item) => item.id === provider.selected);
  const selectionLabel = intl.formatMessage(
    {
      defaultMessage: "{provider} group",
      id: "claudex-api-provider-group",
    },
    { provider: provider.name },
  );
  return jsx(ModelRow, {
    leading:
      vendorMarks.has(provider.id) &&
      jsx("img", {
        src: `/assets/v1/claudex-api-vendor-${provider.id}.svg`,
        alt: "",
        width: 20,
        height: 20,
        className:
          provider.id === "openai" || provider.id === "xai"
            ? "dark:invert"
            : undefined,
      }),
    label: jsx("span", { className: "wrap-anywhere", children: provider.name }),
    rate: group && formatRate(rates[group.id]),
    count: group
      ? jsx(ModelMenu, {
          models: group.modelList ?? [],
          modelCount: group.models,
          onCopy,
        })
      : jsx("span", {
          className: "text-footnote text-secondary",
          children: message("No groups available", "claudex-api-no-groups"),
        }),
    select:
      provider.groups.length > 0 &&
      jsx(Menu, {
        label: jsx("span", {
          className: "truncate",
          children:
            group?.name ?? message("Select group", "claudex-api-select-group"),
        }),
        "aria-label": group
          ? `${selectionLabel}: ${group.name}`
          : selectionLabel,
        className: "claudex-api-model-select",
        align: "end",
        variant: "secondary",
        size: "sm",
        disabled: pending,
        items: provider.groups.map((item) => ({
          label: item.name,
          hint: formatRate(rates[item.id]),
          checked: item.id === provider.selected,
          onSelect: () =>
            item.id !== provider.selected && onSelect(provider.id, item.id),
        })),
      }),
  });
}

function ImageRow({ images, rates, onCopy }) {
  const { locale } = useIntl();
  const chinese = locale.toLowerCase().startsWith("zh");
  return jsx(ModelRow, {
    leading: jsx(Icon, { name: "Image", size: "md" }),
    label: chinese
      ? "生图"
      : message("Image generation", "claudex-api-image-generation"),
    rate: formatRate(rates[images.groupId]),
    count: jsx(ModelMenu, {
      models: images.models,
      modelCount: images.models.length,
      onCopy,
    }),
    select: jsx("span", {
      className: "text-footnote text-secondary whitespace-nowrap",
      children: chinese
        ? "自动选择"
        : message("Automatic selection", "claudex-api-automatic-selection"),
    }),
  });
}

function EndpointList({ origin, onCopy }) {
  if (!origin) return null;
  const entries = [
    {
      label: message("OpenAI-compatible URL", "claudex-api-openai-url"),
      url: origin + "/v1",
    },
    {
      label: message("Messages API URL", "claudex-api-messages-url"),
      url: origin,
    },
  ];
  return jsx(SettingsSection, {
    id: "api-request-urls",
    title: message("Request URLs", "claudex-api-request-urls"),
    dividers: false,
    children: jsx("ul", {
      className: cardGrid,
      children: entries.map(({ label, url }) =>
        jsx(
          "li",
          {
            children: jsx(Card, {
              title: label,
              description: jsx("code", {
                className: "text-code wrap-break-word",
                translate: "no",
                children: url,
              }),
              footer: jsx(Button, {
                variant: "secondary",
                size: "sm",
                icon: "Copy",
                onClick: () => onCopy(url),
                children: message("Copy URL", "claudex-api-copy-url"),
              }),
            }),
          },
          url,
        ),
      ),
    }),
  });
}

function dateCell(value, intl, empty = noValue) {
  if (value === null) return empty;
  return jsx(Tooltip, {
    content: new Date(value).toLocaleString(intl.locale, {
      dateStyle: "full",
      timeStyle: "long",
    }),
    children: jsx("span", {
      className: "text-footnote text-secondary",
      children: intl.formatDate(value),
    }),
  });
}

function KeyActions({ item, onCopy, onRevoke, disabled }) {
  const intl = useIntl();
  return jsx(Menu, {
    iconOnly: true,
    icon: "DotsVertical",
    variant: "ghost",
    size: "sm",
    align: "end",
    disabled,
    "aria-label": intl.formatMessage(
      { defaultMessage: "More actions for key {name}", id: "3HGFiy" },
      { name: item.name },
    ),
    items: [
      {
        label: message("Copy key", "claudex-api-copy-key"),
        icon: "Copy",
        onSelect: () => onCopy(item.id),
      },
      {
        label: message("Revoke key", "/q0o1m"),
        icon: "Trash",
        variant: "danger",
        separatorBefore: true,
        onSelect: () => onRevoke(item),
      },
    ],
  });
}

function KeyList({
  keys,
  rates,
  canCreate,
  onReload,
  onCreate,
  onCopy,
  onRevoke,
}) {
  const intl = useIntl();
  const textCell = (value) =>
    jsx("span", {
      className: "truncate text-footnote text-secondary",
      children: value,
    });
  const columns = [
    {
      id: "name",
      header: () => message("Name", "HAlOn1"),
      cell: ({ row: { original: item } }) =>
        jsx("span", {
          className: "truncate text-body text-primary",
          children: item.name,
        }),
    },
    {
      id: "group",
      header: () => message("Group", "claudex-api-group"),
      cell: ({ row }) => textCell(row.original.groupName || noValue),
    },
    {
      id: "rate",
      header: () => message("Rate", "claudex-api-rate"),
      cell: ({ row }) =>
        textCell(formatRate(rates[row.original.groupId]) ?? noValue),
    },
    {
      id: "key",
      header: () => message("Key", "EcglP9"),
      meta: { minSize: 112 },
      cell: ({ row }) =>
        jsx("code", {
          className: "truncate font-mono text-footnote text-secondary",
          translate: "no",
          children: row.original.key,
        }),
    },
    {
      id: "status",
      header: () => message("Status", "claudex-api-status"),
      cell: ({ row }) =>
        textCell(
          keyStatus[row.original.status] ??
            message("Active", "claudex-api-active"),
        ),
    },
    {
      id: "created",
      header: () => message("Created", "ORGv1Q"),
      cell: ({ row }) => dateCell(row.original.createdAt, intl),
    },
    {
      id: "lastUsed",
      header: () => message("Last used", "claudex-api-last-used"),
      cell: ({ row }) =>
        dateCell(row.original.lastUsedAt, intl, message("Never", "du1laW")),
    },
    {
      id: "cost",
      header: () => message("Total cost", "claudex-api-total-cost"),
      cell: ({ row }) =>
        textCell(
          row.original.totalCost === undefined
            ? noValue
            : intl.formatNumber(row.original.totalCost, {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 4,
              }),
        ),
    },
    {
      id: "actions",
      header: () => null,
      meta: { size: 56, interactive: true, align: "end" },
      cell: ({ row }) =>
        jsx(KeyActions, {
          item: row.original,
          onCopy,
          onRevoke,
          disabled: keys.pending,
        }),
    },
  ];
  return jsxs(SettingsSection, {
    id: "api-keys",
    title: message("API keys", "claudex-api-keys"),
    action: jsx(Button, {
      variant: "primary",
      size: "sm",
      disabled: !canCreate,
      onClick: onCreate,
      children: message("Create a new key", "bCX6nI"),
    }),
    children: [
      keys.error && jsx(Failure, { retry: onReload, children: keys.error }),
      (keys.value !== undefined || keys.pending) &&
        jsx(KeysTable, {
          columns,
          data: keys.value ?? [],
          getRowKey: (item) => item.id,
          isLoading: keys.pending && keys.value === undefined,
          skeletonRowCount: 2,
          emptyState: jsx(EmptyRow, {
            children: message(
              "No API keys have been created yet.",
              "claudex-api-empty-keys",
            ),
          }),
        }),
    ],
  });
}

function Cancel({ onClick, disabled = false }) {
  return jsx(Button, {
    type: "button",
    variant: "secondary",
    disabled,
    onClick,
    children: message("Cancel", "claudex-api-cancel"),
  });
}

function Verification({ actionLabel, perform, onClose }) {
  const [step, setStep] = useState({ kind: "ready" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [now, setNow] = useState(Date.now);
  const deadline = step.kind === "code" ? step.expiresAt : step.retryAt;
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  const entering = step.kind === "code" && now < step.expiresAt;
  const confirmed = step.kind === "confirmed";
  const expired =
    step.kind === "expired" || (step.kind === "code" && !entering);
  const seconds = Math.max(0, Math.ceil(((step.retryAt ?? 0) - now) / 1000));

  async function submit(path, body) {
    if (busy) return;
    const sending = path === "verification/send";
    setBusy(true);
    setFailure("");
    try {
      const result = await perform(path, "POST", body);
      if (sending) {
        const time = Date.now();
        setNow(time);
        setCode("");
        setStep({
          kind: "code",
          address: result.masked_email,
          retryAt: time + (result.retry_after_seconds ?? 60) * 1000,
          expiresAt: time + (result.expires_in_seconds ?? 600) * 1000,
        });
      } else setStep({ kind: "confirmed" });
    } catch (error) {
      if (interrupted(error)) return;
      const time = Date.now();
      setNow(time);
      if (
        error.code === "challenge_expired" ||
        error.code === "challenge_locked" ||
        error.code === "no_email_address"
      ) {
        setStep({
          kind: error.code === "challenge_expired" ? "expired" : "blocked",
        });
      } else if (error.code === "challenge_rate_limited") {
        setStep({ ...step, retryAt: time + (error.seconds ?? 60) * 1000 });
      } else if (error.code === "code_not_sent") {
        setStep({ kind: "ready" });
      } else if (error.code === "invalid_code") {
        setCode("");
      }
      const explanation = verificationErrors[error.code];
      setFailure(explanation ? message(...explanation) : errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const send = () => void submit("verification/send", {});
  const title = jsx(Dialog.Header, {
    children: message("Confirm it’s you", "claudex-api-verify-title"),
  });
  const cancel = jsx(Cancel, { onClick: onClose });
  if (confirmed)
    return jsxs("div", {
      children: [
        title,
        jsx(Dialog.Description, {
          children: message(
            "Confirmed. Press the button again to finish.",
            "claudex-api-verify-confirmed",
          ),
        }),
        jsx(Dialog.Footer, {
          children: jsx(Button, {
            variant: "primary",
            onClick: onClose,
            children: message("Close", "claudex-api-close"),
          }),
        }),
      ],
    });
  if (expired || step.kind === "blocked")
    return jsxs("div", {
      children: [
        title,
        jsx(Failure, {
          children: expired
            ? message(
                "This code expired. Close this and try again to get a new one.",
                "claudex-api-verify-expired",
              )
            : failure,
        }),
        jsx(Dialog.Footer, {
          children: jsx(Button, {
            variant: "primary",
            onClick: onClose,
            children: message("Close", "claudex-api-close"),
          }),
        }),
      ],
    });
  const countdown = message(
    "Send a new code in {seconds}s",
    "claudex-api-verify-wait",
    { seconds },
  );
  const sendButton = jsx(Button, {
    type: "button",
    variant: entering ? "ghost" : "primary",
    busy: busy && !entering,
    disabled: busy || seconds > 0,
    onClick: send,
    children:
      seconds > 0
        ? countdown
        : entering
          ? message("Send a new code", "claudex-api-verify-resend")
          : message("Send code", "claudex-api-verify-send"),
  });
  return jsxs("div", {
    children: [
      title,
      jsxs("form", {
        className: "flex flex-col gap-md",
        onSubmit: (event) => {
          event.preventDefault();
          if (entering && code.length === 6)
            void submit("verification/confirm", { code });
        },
        children: [
          jsx(Dialog.Description, {
            children: entering
              ? message(
                  "Enter the six-digit code we sent to {email}.",
                  "claudex-api-verify-code-sent",
                  {
                    email:
                      step.address ??
                      message("your email address", "claudex-api-verify-email"),
                  },
                )
              : message(
                  "To {action}, confirm your account with a code sent to your email.",
                  "claudex-api-verify-description",
                  { action: actionLabel },
                ),
          }),
          entering &&
            jsx(TextField, {
              label: message("Confirmation code", "claudex-api-verify-code"),
              name: "verification-code",
              autoComplete: "one-time-code",
              inputMode: "numeric",
              value: code,
              maxLength: 6,
              onChange: (event) => {
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                setFailure("");
              },
            }),
          failure && jsx(Failure, { children: failure }),
          entering && jsx("div", { children: sendButton }),
          jsxs(Dialog.Footer, {
            children: [
              cancel,
              entering
                ? jsx(Button, {
                    type: "submit",
                    variant: "primary",
                    busy,
                    disabled: busy || code.length !== 6,
                    children: message("Continue", "claudex-api-continue"),
                  })
                : sendButton,
            ],
          }),
        ],
      }),
    ],
  });
}

function CreateKeyDialog({
  groups,
  rates,
  perform,
  reloadKeys,
  onClose,
  onCreated,
}) {
  const intl = useIntl();
  const [name, setName] = useState("");
  const [group, setGroup] = useState(() =>
    String(groups.find((item) => item.primary)?.id ?? groups[0]?.id ?? ""),
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [verification, setVerification] = useState(null);
  const title = intl.formatMessage({
    defaultMessage: "Create API key",
    id: "+J17tT",
  });
  const trimmed = name.trim();

  async function create(event) {
    event.preventDefault();
    if (!trimmed || !group || busy || feedback?.kind === "uncertain") return;
    setBusy(true);
    setFeedback(null);
    try {
      onCreated(
        await perform("keys", "POST", {
          name: trimmed,
          groupId: Number(group),
        }),
      );
    } catch (error) {
      if (interrupted(error)) return;
      if (error.code === "action_verification_required") {
        setVerification(error.actionLabel || "create an API key");
      } else if (!(error instanceof ApiError) || error.status >= 500) {
        setFeedback({ kind: "uncertain" });
      } else {
        setFeedback({ kind: "error", message: errorText(error) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function checkKeys() {
    setBusy(true);
    try {
      const keys = await reloadKeys();
      const match = keys.some(
        (key) => key.name === trimmed && key.groupId === Number(group),
      );
      setFeedback({ kind: match ? "match" : "checked" });
    } catch (error) {
      if (!interrupted(error))
        setFeedback({ kind: "uncertain", message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }

  let notice;
  if (feedback?.kind === "uncertain") {
    notice = jsx(Failure, {
      retry: busy ? undefined : checkKeys,
      children:
        feedback.message ??
        message(
          "Claudex could not confirm whether it created this key. Check your keys before creating another.",
          "claudex-api-create-uncertain",
        ),
    });
  } else if (feedback?.kind === "error") {
    notice = jsx(Failure, { children: feedback.message });
  } else if (feedback?.kind === "match") {
    notice = jsx(Banner, {
      children: message(
        "A key with this name and group is in your list.",
        "claudex-api-create-match",
      ),
    });
  }

  return jsx(Dialog.Root, {
    open: true,
    dismissible: !busy,
    onOpenChange: (open) => {
      if (!open && !busy) verification ? setVerification(null) : onClose();
    },
    children: jsx(Dialog.Popup, {
      size: "md",
      children: verification
        ? jsx(Verification, {
            actionLabel: verification,
            perform,
            onClose: () => setVerification(null),
          })
        : jsxs("div", {
            children: [
              jsx(Dialog.Header, { showClose: !busy, children: title }),
              jsxs("form", {
                className: "flex flex-col gap-md",
                onSubmit: create,
                children: [
                  jsx(TextField, {
                    label: message("Key name", "KAL6xF"),
                    placeholder: intl.formatMessage({
                      defaultMessage: "e.g., Integration Key",
                      id: "lfMT77",
                    }),
                    value: name,
                    required: true,
                    maxLength: keyNameLimit,
                    readOnly: busy,
                    onChange: (event) => setName(event.target.value),
                  }),
                  jsx(Select, {
                    label: message("Group", "claudex-api-group"),
                    value: group || null,
                    onChange: (value) => setGroup(value ?? ""),
                    disabled: busy,
                    items: groups.map((item) => {
                      const rate = formatRate(rates[item.id]);
                      return {
                        value: String(item.id),
                        label: rate ? `${item.name} · ${rate}` : item.name,
                      };
                    }),
                  }),
                  notice,
                  jsxs(Dialog.Footer, {
                    children: [
                      jsx(Cancel, { onClick: onClose, disabled: busy }),
                      jsx(Button, {
                        type: "submit",
                        variant: "primary",
                        busy,
                        disabled:
                          busy ||
                          !trimmed ||
                          !group ||
                          feedback?.kind === "uncertain",
                        children: message(
                          "Create key",
                          "claudex-api-create-key",
                        ),
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
    }),
  });
}

export function HostApiPanel({ refreshBootstrap }) {
  const intl = useIntl();
  const { addSuccess, addError } = useNotices();
  const session = useRef(null);
  const [groups, setGroups] = useState(emptyRead);
  const [rates, setRates] = useState(emptyRead);
  const [keys, setKeys] = useState(emptyRead);
  const [balance, setBalance] = useState(emptyRead);
  const [creating, setCreating] = useState(false);
  const [selectionPending, setSelectionPending] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState("");
  const [accessLost, setAccessLost] = useState(false);

  function refreshModels() {
    void refreshBootstrap({ ambient: true, cancelRefetch: true }).catch(
      () => {},
    );
  }

  async function perform(path, method, data, controller = session.current) {
    if (!controller) throw new DOMException("API page closed", "AbortError");
    try {
      return await request(path, controller.signal, method, data);
    } catch (error) {
      if (error.status !== 401 && error.code !== "account_operation_stale")
        throw error;
      controller.abort();
      setAccessLost(true);
      refreshModels();
      throw new DOMException("API account changed", "AbortError");
    }
  }

  async function load(target, set, controller = session.current) {
    set((state) => ({ ...state, pending: true, error: "" }));
    try {
      const value = await perform(target, "GET", undefined, controller);
      set({ value, error: "", pending: false });
      return value;
    } catch (error) {
      if (!interrupted(error))
        set((state) => ({ ...state, pending: false, error: errorText(error) }));
      throw error;
    }
  }

  async function loadGroups(controller = session.current) {
    setGroups((state) => ({ ...state, pending: true, error: "" }));
    try {
      const cached = await perform("groups", "GET", undefined, controller);
      setGroups({ value: cached, error: "", pending: true });
      await load("groups?fresh=1", setGroups, controller);
    } catch (error) {
      if (!interrupted(error))
        setGroups((state) => ({
          ...state,
          pending: false,
          error: errorText(error),
        }));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    session.current = controller;
    const refreshBalance = () => void load("balance", setBalance, controller).catch(() => {});
    refreshBalance();
    void loadGroups(controller);
    void load("rates", setRates, controller).catch(() => {});
    void load("keys", setKeys, controller).catch(() => {});
    window.addEventListener("focus", refreshBalance);
    return () => {
      window.removeEventListener("focus", refreshBalance);
      controller.abort();
      session.current = null;
    };
  }, []);

  async function setGroup(providerId, groupId) {
    setSelectionPending(true);
    try {
      const value = await perform("groups", "POST", { providerId, groupId });
      setGroups({ value, error: "", pending: false });
      refreshModels();
    } catch (error) {
      if (!interrupted(error)) addError(errorText(error));
    } finally {
      setSelectionPending(false);
    }
  }

  function notice(defaultMessage, id) {
    addSuccess(intl.formatMessage({ defaultMessage, id }));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      notice("Copied to clipboard", "claudex-api-copied");
    } catch {
      addError(
        intl.formatMessage({
          defaultMessage: "Couldn’t copy. Try again.",
          id: "claudex-api-copy-failed",
        }),
      );
    }
  }

  async function copyKey(id) {
    const controller = session.current;
    if (!controller) return;
    const value = perform(`keys/${id}/copy`, "POST", {}, controller).then(
      ({ key }) => {
        controller.signal.throwIfAborted();
        return key;
      },
    );
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
        const text = value.then(
          (key) => new Blob([key], { type: "text/plain" }),
        );
        void text.catch(() => {});
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": text }),
        ]);
      } else {
        await navigator.clipboard.writeText(await value);
      }
      controller.signal.throwIfAborted();
      notice("API key copied", "claudex-api-key-copied");
    } catch (error) {
      const failure = await value.then(
        () => error,
        (reason) => reason,
      );
      if (!interrupted(failure) && !controller.signal.aborted)
        addError(
          failure instanceof ApiError
            ? failure.message
            : intl.formatMessage({
                defaultMessage: "Couldn’t copy the key. Try again.",
                id: "claudex-api-key-copy-failed",
              }),
        );
    }
  }

  async function revoke() {
    setRevokeError("");
    try {
      await perform(`keys/${revoking.id}`, "DELETE");
      setKeys((state) => ({
        ...state,
        value: state.value.filter((key) => key.id !== revoking.id),
      }));
      setRevoking(null);
      notice("API key revoked", "claudex-api-key-revoked");
    } catch (error) {
      if (!interrupted(error)) setRevokeError(errorText(error));
    }
  }

  const data = groups.value;
  const rateTable = rates.value ?? {};
  const pending = groups.pending || selectionPending;
  const reloadKeys = () => load("keys", setKeys);
  return jsx("div", {
    className: "h-full overflow-y-auto",
    children: jsx(ScheduledPage, {
      header: false,
      banner: jsx(PageHeader, { title: "API" }),
      contentGap: "lg",
      children: accessLost
        ? jsx(Failure, {
            children: message(
              "Your session ended. Sign in again to manage API keys.",
              "claudex-api-session-ended",
            ),
          })
        : jsxs("div", {
            className: "flex flex-col gap-xl",
            children: [
              jsx("link", {
                rel: "stylesheet",
                href: "/assets/v1/claudex-host-api.css",
              }),
              jsx(ApiBalance, {
                balance,
                onReload: () => void load("balance", setBalance).catch(() => {}),
              }),
              jsxs(SettingsSection, {
                id: "api-providers",
                title: message("Models", "claudex-api-models"),
                description: message(
                  "The selected group sets the models and rates in Claudex. API keys use their own groups.",
                  "claudex-api-group-description",
                ),
                dividers: false,
                children: [
                  groups.error &&
                    jsx(Failure, {
                      retry: () => void loadGroups(),
                      children: groups.error,
                    }),
                  rates.error &&
                    jsx(Failure, {
                      retry: () => void load("rates", setRates).catch(() => {}),
                      children: rates.error,
                    }),
                  !data && groups.pending && jsx(ModelRowsSkeleton, {}),
                  data &&
                    (data.providers.length > 0 || data.images) &&
                    jsx(SettingsNest, {
                      padding: "none",
                      children: jsxs("ul", {
                        role: "list",
                        "aria-label": intl.formatMessage({
                          defaultMessage: "Providers",
                          id: "claudex-api-providers",
                        }),
                        className: "divide-y divide-alpha-1",
                        children: [
                          ...data.providers.map((provider) =>
                            jsx(
                              ProviderRow,
                              {
                                provider,
                                rates: rateTable,
                                pending,
                                onCopy: copyText,
                                onSelect: (providerId, groupId) =>
                                  void setGroup(providerId, groupId),
                              },
                              provider.id,
                            ),
                          ),
                          data.images &&
                            jsx(ImageRow, {
                              images: data.images,
                              rates: rateTable,
                              onCopy: copyText,
                            }),
                        ],
                      }),
                    }),
                ],
              }),
              jsx(KeyList, {
                keys,
                rates: rateTable,
                canCreate:
                  !pending && !keys.pending && Boolean(data?.groups.length),
                onReload: () => void reloadKeys().catch(() => {}),
                onCreate: () => setCreating(true),
                onCopy: copyKey,
                onRevoke: (item) => {
                  setRevokeError("");
                  setRevoking(item);
                },
              }),
              jsx(EndpointList, { origin: data?.origin, onCopy: copyText }),
              creating &&
                jsx(CreateKeyDialog, {
                  groups: data.groups,
                  rates: rateTable,
                  perform,
                  reloadKeys,
                  onClose: () => setCreating(false),
                  onCreated: (item) => {
                    setKeys((state) => ({
                      ...state,
                      value: [
                        item,
                        ...(state.value ?? []).filter(
                          (key) => key.id !== item.id,
                        ),
                      ],
                    }));
                    setCreating(false);
                    notice("API key created", "claudex-api-key-created");
                  },
                }),
              jsx(ConfirmDialog, {
                open: revoking !== null,
                onOpenChange: (open) => !open && setRevoking(null),
                title: message("Revoke {keyName}?", "oBXvAZ", {
                  keyName: revoking?.name ?? "",
                }),
                description: message(
                  "Anything authenticating with this key will lose access. This action cannot be undone.",
                  "9ORjME",
                ),
                cancelLabel: message("Cancel", "claudex-api-cancel"),
                confirmLabel: message("Revoke", "tnRDuU"),
                confirmVariant: "danger",
                initialFocus: "cancel",
                onConfirm: revoke,
                children:
                  revokeError && jsx(Failure, { children: revokeError }),
              }),
            ],
          }),
    }),
  });
}
