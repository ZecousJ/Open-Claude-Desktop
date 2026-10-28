import { useEffect, useRef, useState } from "react";
import { X } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { formatText, t } from "../i18n";
import type { DevServerState } from "../../shared/browser";
import { Modal } from "../ui/Controls";

/**
 * Start dev server?. Starting a configuration from the panel asks once, showing
 * the command and where it runs; there is no "always".
 */
export function StartServerDialog({
  server,
  folder,
  onStart,
  onClose,
}: {
  server: DevServerState;
  folder?: string;
  onStart: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The sentence is one catalog entry; the server's name is set in bold at {name}.
  const [before, after = ""] = formatText(
    server.port
      ? "{name} on port {port} runs this command on your computer, outside the sandbox:"
      : "{name} runs this command on your computer, outside the sandbox:",
    { port: server.port ?? "" },
  ).split("{name}");
  return (
    <Modal title="Start dev server?" onClose={onClose} variant="confirm">
      <div className="browser-start">
        <p>
          {before}
          <strong>{server.name}</strong>
          {after}
        </p>
        <code className="browser-command">{server.command}</code>
        {folder && (
          <p className="browser-form-note">
            {formatText("In {page}", { page: folder })}
          </p>
        )}
        {error && (
          <p className="browser-form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="button-row">
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onStart()
              .then(onClose)
              .catch((reason) => {
                setBusy(false);
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              });
          }}
        >
          {busy && <Spinner inheritColor size={14} className="spin" />}
          Start
        </button>
      </div>
    </Modal>
  );
}

/** A log line's colour: errors red, warnings amber. */
export function logLineTone(line: string): "error" | "warn" | undefined {
  const head = line.slice(0, 200).toUpperCase();
  if (["ERROR", "ERR!", "FATAL", "FAIL"].some((word) => head.includes(word)))
    return "error";
  return head.includes("WARN") ? "warn" : undefined;
}

/**
 * The dev server logs drawer under the page: 200px tall (80px to 60%), its top
 * edge drags it taller or shorter; a header with "{name} · localhost:{port}" in
 * caption muted and a ghost X (Close dev server logs); the output in code
 * secondary, errors red and warnings amber, kept scrolled to the end while it
 * is at the end, "Waiting for output…" before there is any.
 */
export function DevServerLogsDrawer({
  server,
  onRead,
  onClose,
}: {
  server: DevServerState;
  onRead: () => Promise<string[]>;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    let live = true;
    const read = () =>
      void onRead().then(
        (value) => live && setLines(value),
        () => {},
      );
    read();
    const timer = setInterval(read, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [server.name]);
  useEffect(() => {
    const element = body.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  const source = server.port
    ? formatText("{name} · {host}", {
        name: server.name,
        host: `localhost:${server.port}`,
      })
    : server.name;
  return (
    <div ref={box} className="browser-logs-drawer">
      <div
        role="separator"
        aria-orientation="horizontal"
        className="browser-logs-resize"
        onPointerDown={(event) => {
          const element = box.current;
          if (event.button !== 0 || !element) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const startY = event.clientY;
          const startHeight = element.getBoundingClientRect().height;
          const move = (next: PointerEvent) => {
            element.style.height = `${Math.max(80, startHeight + (startY - next.clientY))}px`;
          };
          const target = event.currentTarget;
          const end = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", end);
            target.removeEventListener("pointercancel", end);
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", end);
          target.addEventListener("pointercancel", end);
        }}
      />
      <div className="browser-logs-head">
        <span title={source}>{source}</span>
        <button
          type="button"
          className="preview-icon-button"
          aria-label={t("Close dev server logs")}
          title={t("Close dev server logs")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div
        ref={body}
        className="browser-logs-body"
        onScroll={() => {
          const element = body.current;
          if (element)
            atEnd.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              8;
        }}
      >
        {lines.length ? (
          lines.map((line, index) => (
            <div key={index} data-tone={logLineTone(line)}>
              {line}
            </div>
          ))
        ) : (
          <div className="browser-logs-waiting">{t("Waiting for output…")}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Closing a tab whose dev server runs: "Close {host}?" or "Close other tabs?",
 * that the server keeps running and how to come back, then Cancel on the left
 * and Stop server (red) and Keep running on the right.
 */
export function CloseRunningTabDialog({
  servers,
  others,
  onStop,
  onKeep,
  onClose,
}: {
  servers: DevServerState[];
  /** Close other tabs rather than this one. */
  others: boolean;
  onStop: () => Promise<void>;
  onKeep: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const first = servers[0];
  const host = first?.port ? `localhost:${first.port}` : "";
  const name = first?.name ?? t("the dev server");
  const count = servers.length;
  const title = others
    ? t("Close other tabs?")
    : formatText("Close {host}?", { host });
  const body =
    count > 1
      ? formatText(
          "{count} dev servers are still running. You can keep them running and reopen a tab any time by entering its localhost address in the URL bar.",
          { count },
        )
      : formatText(
          others
            ? "{serverLabel} is still running. You can keep it running and reopen a tab any time by entering {host} in the URL bar."
            : "{serverLabel} is still running. You can keep it running and reopen this tab any time by entering {host} in the URL bar.",
          { serverLabel: name, host },
        );
  return (
    <Modal title={title} onClose={onClose} variant="confirm">
      <p className="confirm-body">{body}</p>
      <div className="button-row browser-close-buttons">
        <button className="secondary" onClick={onClose}>
          {t("Cancel")}
        </button>
        <span>
          <button
            className="primary danger-button"
            disabled={busy}
            aria-label={
              count > 1
                ? formatText("Stop {count} servers and close", { count })
                : t("Stop server and close")
            }
            onClick={() => {
              setBusy(true);
              void onStop().finally(onClose);
            }}
          >
            {count > 1 ? t("Stop servers") : t("Stop server")}
          </button>
          <button
            className="primary"
            autoFocus
            onClick={() => {
              onKeep();
              onClose();
            }}
          >
            {t("Keep running")}
          </button>
        </span>
      </div>
    </Modal>
  );
}
