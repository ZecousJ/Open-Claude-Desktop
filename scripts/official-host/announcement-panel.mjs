import {
  Do as useState,
  Eo as useRef,
  Ja as jsxs,
  Ka as Fragment,
  wo as useMemo,
  qa as jsx,
  vo as useEffect,
} from "./vendor-frame-iz8L1jC9.js";
import {
  l as Message,
  p as useIntl,
  t as FormattedDate,
} from "./vendor-intl-D9Num-b5.js";
import {
  Ft as Dialog,
  ah as Notice,
  fX as Badge,
  kv as openWindow,
  ln as useWindow,
  tw as Button,
  uR as Skeleton,
} from "./shared-frame-DH1u5uQk.js";
import { B5 as RemoteImage, Ua as Markdown } from "./shared-12-Dk64PZOo.js";
import { hz as ConfirmExternalLink } from "./shared-w-0-DddGQu6H.js";

const endpoint = "/api/claudex/service-announcements";
const refreshMs = 60_000;
const empty = { rows: null, loadError: false, writes: new Map() };

const notices = {
  path: endpoint,
  key: ({ id }) => id,
  afterRead: (rows, id) =>
    rows?.map((row) => (row.id === id ? { ...row, read: true } : row)) ?? null,
};
const popups = {
  path: endpoint + "/pending",
  key: ({ id }) => id,
  afterRead: (rows, id) => rows?.filter((row) => row.id !== id) ?? null,
};

async function request(path, signal, method = "GET", body) {
  const response = await fetch(path, {
    method,
    signal,
    cache: "no-store",
    ...(body && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) throw new Error("Announcement request failed");
  return method === "GET" ? await response.json() : undefined;
}

function useFeed(accountId, stream) {
  const [state, setState] = useState(empty);
  const actions = useRef(null);

  useEffect(() => {
    const scope = new AbortController();
    const { signal } = scope;
    let reading;
    const writing = new Set();
    const writeState = (id, status) => {
      setState((current) => {
        const writes = new Map(current.writes);
        if (status) writes.set(id, status);
        else writes.delete(id);
        return { ...current, writes };
      });
    };

    const refresh = async (replace = false) => {
      if (signal.aborted || (reading && !replace)) return;
      reading?.abort();
      const controller = new AbortController();
      reading = controller;
      try {
        const rows = await request(stream.path, controller.signal);
        if (!Array.isArray(rows))
          throw new Error("Invalid announcements response");
        if (controller.signal.aborted) return;
        setState((current) => {
          const unread = new Set(
            rows.filter((row) => !row.read).map(stream.key),
          );
          const writes = new Map(
            [...current.writes].filter(
              ([id, status]) => status.saving || unread.has(id),
            ),
          );
          return { rows, loadError: false, writes };
        });
      } catch {
        if (!controller.signal.aborted)
          setState((current) => ({ ...current, loadError: true }));
      } finally {
        if (reading === controller) reading = undefined;
      }
    };

    const mark = async (id, action) => {
      if (signal.aborted || writing.has(id)) return;
      writing.add(id);
      writeState(id, { saving: true, action });
      try {
        await request(
          stream.path + "/" + encodeURIComponent(id) + "/read",
          signal,
          "POST",
          action && { action },
        );
        if (signal.aborted) return;
        setState((current) => ({
          ...current,
          rows: stream.afterRead(current.rows, id),
        }));
        writeState(id, null);
        void refresh(true);
      } catch {
        if (!signal.aborted) {
          writeState(id, { saving: false, action });
          void refresh(true);
        }
      } finally {
        writing.delete(id);
      }
    };

    const whenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    actions.current = { refresh: () => refresh(true), mark };
    void refresh();
    const timer = setInterval(whenVisible, refreshMs);
    window.addEventListener("focus", whenVisible);
    document.addEventListener("visibilitychange", whenVisible);

    return () => {
      scope.abort();
      reading?.abort();
      actions.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", whenVisible);
      document.removeEventListener("visibilitychange", whenVisible);
    };
  }, [accountId, stream]);

  return [state, actions];
}

const copy = {
  retry: { defaultMessage: "Try again", id: "FazwRldA7z" },
  dismiss: { defaultMessage: "Dismiss", id: "TDaF6JVgG6" },
  done: { defaultMessage: "Done", id: "JXdbo8Vnlw" },
  notNow: { defaultMessage: "Not now", id: "dUCA4Khx0S" },
  showImage: { defaultMessage: "Show Image", id: "eFsJ8k" },
};

function label(intl, english, chinese) {
  return intl.locale.startsWith("zh") ? chinese : english;
}

function ErrorNotice({ message, retry }) {
  return jsx(Notice, {
    variant: "danger",
    role: "alert",
    action: jsx(Button, {
      variant: "secondary",
      size: "sm",
      onClick: retry,
      children: jsx(Message, copy.retry),
    }),
    children: message,
  });
}

export function HostAnnouncementNotice({ notice, onRead, onDismiss, write }) {
  const intl = useIntl();
  const failed = write && !write.saving;
  return jsx(Notice, {
    variant: failed ? "danger" : "neutral",
    icon: "Info",
    composerCalibration: true,
    role: "status",
    "data-testid": "claudex-announcement-notice",
    action: jsxs("span", {
      className: "flex items-center gap-sm",
      children: [
        jsx(Button, {
          variant: "secondary",
          size: "sm",
          onClick: onRead,
          children: label(intl, "Read", "阅读"),
        }),
        failed &&
          jsx(Button, {
            variant: "secondary",
            size: "sm",
            onClick: onDismiss,
            children: jsx(Message, copy.retry),
          }),
      ],
    }),
    onDismiss: write ? undefined : onDismiss,
    dismissLabel: intl.formatMessage(copy.dismiss),
    children: failed
      ? jsxs(Fragment, {
          children: [
            notice.title,
            jsx("p", {
              children: label(
                intl,
                "Couldn’t mark this announcement as read.",
                "无法将此公告标记为已读。",
              ),
            }),
          ],
        })
      : notice.title,
  });
}

function Archive({
  open,
  onOpenChange,
  state,
  actions,
  pendingError,
  retryPending,
}) {
  const intl = useIntl();
  const focus = useRef(null);
  const failed = [...state.writes].filter(([, status]) => !status.saving);
  return jsx(Dialog.Root, {
    open,
    onOpenChange,
    children: jsxs(Dialog.Popup, {
      ref: focus,
      initialFocus: focus,
      size: "md",
      className: "flex max-h-[min(720px,85vh)] flex-col",
      "data-testid": "claudex-service-announcements-dialog",
      children: [
        jsx(Dialog.Header, {
          showClose: true,
          children: label(intl, "Service announcements", "服务公告"),
        }),
        jsxs("div", {
          className:
            "-mx-pad-xl -mb-pad-xl flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto px-xl pb-xl pt-md in-data-cds-fizzy:flex-none in-data-cds-fizzy:overflow-visible in-data-cds-fizzy:pt-0",
          children: [
            state.loadError &&
              jsx(ErrorNotice, {
                message: label(
                  intl,
                  "Couldn’t load service announcements.",
                  "无法加载服务公告。",
                ),
                retry: () => actions.current?.refresh(),
              }),
            pendingError &&
              jsx(ErrorNotice, {
                message: label(
                  intl,
                  "Couldn’t load announcement pop-ups.",
                  "无法加载公告弹窗。",
                ),
                retry: retryPending,
              }),
            failed.length > 0 &&
              jsx(ErrorNotice, {
                message: label(
                  intl,
                  "Couldn’t mark announcements as read.",
                  "无法将公告标记为已读。",
                ),
                retry: () =>
                  failed.forEach(([id]) => void actions.current?.mark(id)),
              }),
            !state.rows && !state.loadError && jsx(Skeleton.Rows, { rows: 3 }),
            state.rows?.length === 0 &&
              jsx("p", {
                className: "p-lg text-center text-body text-secondary",
                children: label(intl, "No announcements yet.", "暂无公告。"),
              }),
            state.rows?.map((row) =>
              jsxs(
                "section",
                {
                  className:
                    "flex flex-col gap-md border-b pb-lg last:border-0 last:pb-0",
                  children: [
                    jsxs("div", {
                      className: "flex items-center justify-between gap-sm",
                      children: [
                        jsx("h4", {
                          className: "text-heading font-semibold text-primary",
                          children: row.title,
                        }),
                        row.createdAt > 0 &&
                          jsx("time", {
                            className: "shrink-0 text-caption text-secondary",
                            dateTime: new Date(row.createdAt).toISOString(),
                            children: jsx(FormattedDate, {
                              value: row.createdAt,
                              year: "numeric",
                              month: "long",
                              day: "numeric",
                            }),
                          }),
                      ],
                    }),
                    jsx(Markdown, {
                      text: row.content,
                      className: "text-body text-secondary",
                      allowDontAskAgain: false,
                    }),
                  ],
                },
                row.id,
              ),
            ),
          ],
        }),
      ],
    }),
  });
}

function externalUrl(value) {
  const url = URL.parse(value);
  return url && (url.protocol === "https:" || url.protocol === "http:")
    ? url.href
    : null;
}

function richDocument(html, showImage) {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content
    .querySelectorAll(
      "base, meta, script, iframe, frame, object, embed, link, template",
    )
    .forEach((node) => node.remove());
  const actions = new Map();
  template.content
    .querySelectorAll("[data-announcement-action]")
    .forEach((node) => node.removeAttribute("data-announcement-action"));
  for (const link of template.content.querySelectorAll("a, area")) {
    const url = externalUrl(
      link.getAttribute("href") ?? link.getAttribute("xlink:href"),
    );
    link.removeAttribute("href");
    link.removeAttribute("xlink:href");
    link.removeAttribute("target");
    link.removeAttribute("download");
    if (!url) continue;
    const id = String(actions.size);
    actions.set(id, url);
    link.setAttribute("href", "#");
    link.setAttribute("data-announcement-action", id);
  }
  for (const img of template.content.querySelectorAll("img")) {
    const url = externalUrl(img.getAttribute("src"));
    const alt = img.getAttribute("alt");
    if (!url || img.closest("[data-announcement-action]")) {
      img.replaceWith(alt ?? "");
      continue;
    }
    const id = String(actions.size);
    actions.set(id, url);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = showImage;
    if (alt) button.title = alt;
    button.setAttribute("data-announcement-action", id);
    img.replaceWith(button);
  }

  const content =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\">" +
    "<style>html,body{margin:0;padding:0;background:transparent}body{word-wrap:break-word}" +
    "p{margin:0 0 12px}ul,ol{margin:0 0 12px;padding-inline-start:22px}li{margin:0 0 8px}" +
    "h1,h2,h3{margin:0 0 12px;line-height:1.25}a{color:light-dark(#184f95,#83a3d7)}" +
    "button[data-announcement-action]{display:inline-grid;place-items:center;width:10rem;" +
    "min-height:8rem;border:1px solid light-dark(#d6d3cd,#45443f);border-radius:0.75rem;" +
    "color:light-dark(#605d55,#bdb9ae);background:light-dark(#f5f4ed,#272624);font:inherit;cursor:pointer}</style>" +
    "</head><body>" +
    template.innerHTML +
    "</body></html>";
  return { content, actions };
}

function RichBody({ html, onOpenLink, onClose }) {
  const intl = useIntl();
  const frame = useRef(null);
  const callbacks = useRef({ onOpenLink, onClose });
  const showImage = intl.formatMessage(copy.showImage);
  const { content, actions } = useMemo(
    () => richDocument(html, showImage),
    [html, showImage],
  );
  const [height, setHeight] = useState(64);
  const [loaded, setLoaded] = useState(null);
  useEffect(() => {
    callbacks.current = { onOpenLink, onClose };
  }, [onOpenLink, onClose]);
  useEffect(() => {
    const node = frame.current;
    const doc = node.contentDocument;
    if (loaded !== content || !doc?.body) return;
    const syncTheme = () => {
      const theme = getComputedStyle(node);
      doc.documentElement.style.colorScheme = theme.colorScheme;
      doc.documentElement.style.color = theme.color;
      doc.documentElement.style.font = theme.font;
    };
    const resizeBody = () =>
      setHeight(
        Math.min(320, Math.ceil(doc.body.getBoundingClientRect().height)),
      );
    const size = new ResizeObserver(resizeBody);
    const theme = new MutationObserver(syncTheme);
    const root = node.closest(".cds-root");
    if (root) theme.observe(root, { attributes: true });
    theme.observe(document.documentElement, { attributes: true });
    const systemTheme = matchMedia("(prefers-color-scheme: dark)");
    systemTheme.addEventListener("change", syncTheme);
    const click = (event) => {
      const id = event.target
        .closest?.("[data-announcement-action]")
        ?.getAttribute("data-announcement-action");
      const url = actions.get(id);
      if (!url) return;
      event.preventDefault();
      callbacks.current.onOpenLink(url);
    };
    const keys = (event) => {
      if (event.key === "Escape") callbacks.current.onClose();
    };
    doc.addEventListener("click", click);
    doc.addEventListener("auxclick", click);
    doc.addEventListener("keydown", keys);
    syncTheme();
    resizeBody();
    size.observe(doc.body);
    return () => {
      size.disconnect();
      theme.disconnect();
      systemTheme.removeEventListener("change", syncTheme);
      doc.removeEventListener("click", click);
      doc.removeEventListener("auxclick", click);
      doc.removeEventListener("keydown", keys);
    };
  }, [content, actions, loaded]);
  return jsx("iframe", {
    ref: frame,
    sandbox: "allow-same-origin",
    srcDoc: content,
    className: "w-full border-0 text-body text-primary",
    style: { height, minHeight: 0 },
    referrerPolicy: "no-referrer",
    title: label(intl, "Announcement", "公告"),
    onLoad: () => setLoaded(content),
  });
}

function Popup({ item, write, mark }) {
  const intl = useIntl();
  const hostWindow = useWindow();
  const [destination, setDestination] = useState(null);
  const primaryUrl = externalUrl(item.primaryUrl);
  const imageUrl = externalUrl(item.imageUrl);
  const close = () => {
    if (!destination && !write?.saving) void mark("close");
  };
  const openExternal = ({ url, action }) => {
    openWindow(hostWindow, url, "_blank", "noopener,noreferrer");
    if (action) void mark(action);
    setDestination(null);
  };
  return jsxs(Dialog.Root, {
    open: true,
    onOpenChange: (open) => {
      if (!open) close();
    },
    children: [
      jsx(Dialog.Popup, {
        size: imageUrl ? "xl" : "sm",
        className: "flex max-h-[min(720px,85vh)] flex-col",
        "data-testid": "claudex-announcement-popup",
        children: jsxs("div", {
          className: imageUrl
            ? "flex flex-col gap-lg overflow-y-auto sm:flex-row"
            : "flex flex-col overflow-y-auto",
          children: [
            jsxs("div", {
              className: "flex min-w-0 flex-1 flex-col gap-lg",
              "aria-busy": !!write?.saving,
              children: [
                jsx(Dialog.Header, {
                  showClose: false,
                  className: "pr-xl",
                  children: jsxs("span", {
                    className: "flex flex-col items-start gap-md",
                    children: [
                      item.badge &&
                        jsx(Badge, { variant: "blue", children: item.badge }),
                      jsx("span", {
                        className: "font-serif text-title",
                        children:
                          item.title || label(intl, "Announcement", "公告"),
                      }),
                    ],
                  }),
                }),
                item.bodyFormat === "html"
                  ? jsx(RichBody, {
                      html: item.bodyHtml,
                      onOpenLink: (url) => setDestination({ url }),
                      onClose: close,
                    })
                  : jsx("div", {
                      className: "flex flex-col gap-md text-body text-primary",
                      children: item.bodyHtml
                        .split(/\r?\n/)
                        .filter((line) => line.trim())
                        .map((line, i) => jsx("p", { children: line }, i)),
                    }),
                write &&
                  !write.saving &&
                  jsx(ErrorNotice, {
                    message: label(
                      intl,
                      "Couldn’t mark this announcement as read.",
                      "无法将此公告标记为已读。",
                    ),
                    retry: () => void mark(write.action),
                  }),
                jsxs("div", {
                  className: "flex flex-col gap-sm",
                  children: [
                    jsx(Button, {
                      variant: "primary",
                      disabled: write?.saving,
                      onClick: () =>
                        primaryUrl
                          ? setDestination({
                              url: primaryUrl,
                              action: "primary",
                            })
                          : void mark("dismiss"),
                      children:
                        item.primaryLabel ||
                        (primaryUrl
                          ? label(intl, "Open", "打开")
                          : jsx(Message, copy.done)),
                    }),
                    primaryUrl &&
                      jsx(Button, {
                        variant: "secondary",
                        disabled: write?.saving,
                        onClick: () => void mark("dismiss"),
                        children:
                          item.dismissLabel || jsx(Message, copy.notNow),
                      }),
                  ],
                }),
              ],
            }),
            imageUrl &&
              jsx("div", {
                className:
                  "flex min-w-0 flex-1 items-center justify-center rounded-lg bg-surface-2",
                children: jsx(RemoteImage, {
                  src: imageUrl,
                  alt: "",
                  allowDontAskAgain: false,
                }),
              }),
            jsx(Dialog.CloseButton, { className: "absolute end-4 top-4" }),
          ],
        }),
      }),
      destination &&
        jsx(ConfirmExternalLink, {
          isOpen: true,
          url: destination.url,
          allowDontAskAgain: false,
          onClose: () => setDestination(null),
          onConfirm: () => openExternal(destination),
        }),
    ],
  });
}

function AccountAnnouncements({
  accountId,
  open,
  onOpenChange,
  onUnreadChange,
  onNoticeChange,
}) {
  const [ordinary, ordinaryActions] = useFeed(accountId, notices);
  const [pending, pendingActions] = useFeed(accountId, popups);
  const opened = useRef(false);
  const popup = pending.rows?.[0];
  const unread = !!popup || (ordinary.rows?.some((row) => !row.read) ?? false);
  const ordinaryPopup =
    !open && !popup && ordinary.rows?.find((row) => row.popup && !row.read);
  const bannerWrite = ordinaryPopup
    ? ordinary.writes.get(ordinaryPopup.id)
    : undefined;
  const showArchive = open && !popup;

  useEffect(() => {
    onUnreadChange(unread);
  }, [onUnreadChange, unread]);

  useEffect(() => {
    if (!onNoticeChange) return;
    const notice = ordinaryPopup;
    onNoticeChange(
      notice
        ? {
            notice,
            write: bannerWrite,
            onRead: () => onOpenChange(true),
            onDismiss: () => void ordinaryActions.current?.mark(notice.id),
          }
        : null,
    );
  }, [ordinaryPopup, bannerWrite, onNoticeChange, onOpenChange]);

  useEffect(() => () => onNoticeChange?.(null), [onNoticeChange]);

  useEffect(() => {
    if (!open) opened.current = false;
    if (!showArchive || !ordinary.rows || opened.current) return;
    opened.current = true;
    for (const { id, read } of ordinary.rows) {
      if (!read && !ordinary.writes.has(id))
        void ordinaryActions.current?.mark(id);
    }
  }, [open, showArchive, ordinary.rows, ordinary.writes]);

  return jsxs(Fragment, {
    children: [
      jsx(Archive, {
        open: showArchive,
        onOpenChange,
        state: ordinary,
        actions: ordinaryActions,
        pendingError: pending.loadError,
        retryPending: () => pendingActions.current?.refresh(),
      }),
      popup &&
        jsx(
          Popup,
          {
            item: popup,
            write: pending.writes.get(popup.id),
            mark: (action) => pendingActions.current?.mark(popup.id, action),
          },
          popup.id,
        ),
    ],
  });
}

export function HostAnnouncements(props) {
  return props.accountId
    ? jsx(AccountAnnouncements, props, props.accountId)
    : null;
}
