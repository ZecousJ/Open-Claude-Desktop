import { useEffect, useRef, useState } from "react";
import type { Conversation, Item } from "../../shared/types";
import { sessionWidgets, type WidgetResource } from "../../shared/widget";
import { SessionPaneFrame } from "../app/SessionPaneFrame";
import { useApp } from "../app/AppContext";
import { api } from "../desktop-api";
import { formatText, t } from "../i18n";
import { useArtifactTools } from "../artifacts/useArtifactTools";
import { widgetDocument } from "./widget-document";
import { arrangePane } from "../app/pane-expand";
import { useOpenLink } from "../ui/ExternalLinks";
import { mcpOutput } from "../transcript/tools/McpToolView";

export function WidgetPanel({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const app = useApp();
  const items = sessionWidgets(conversation.turns);
  const selected =
    items.find((item) => item.id === app.toolPanels.widgetId) ?? items.at(-1);
  return (
    <SessionPaneFrame pane="widget" title="Widget" onClose={onClose}>
      <div className="widget-pane-body">
        {items.length > 1 && (
          <select
            aria-label={t("Widget")}
            value={selected?.id}
            onChange={(event) => app.toolPanels.setWidgetId(event.target.value)}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.server} · {item.tool}
              </option>
            ))}
          </select>
        )}
        {selected &&
          (app.snapshot.settings.disableNonessentialServices ? (
            <div className="mcp-tool-body">
              {mcpOutput(selected).map((entry, index) =>
                entry.type === "text" ? (
                  <pre key={index}>{entry.text}</pre>
                ) : null,
              )}
            </div>
          ) : (
            <Widget
              key={`${conversation.id}:${selected.id}`}
              conversationId={conversation.id}
              item={selected}
            />
          ))}
      </div>
    </SessionPaneFrame>
  );
}

function Widget({
  conversationId,
  item,
}: {
  conversationId: string;
  item: Item;
}) {
  const app = useApp();
  const [resource, setResource] = useState<WidgetResource>();
  const [error, setError] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const identity = `widget:${conversationId}:${item.id}`;
  const tools = useArtifactTools(
    frame,
    identity,
    resource?.html ?? "",
    item.server,
  );
  const openLink = useOpenLink();
  useEffect(() => {
    let live = true;
    void api.widgetResource(conversationId, item.id).then(
      (next) => {
        if (live) setResource(next);
      },
      () => {
        if (live) setError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [conversationId, item.id]);
  const latest = useRef(item);
  latest.current = item;
  useEffect(() => {
    const notify = (method: string, params: unknown) =>
      frame.current?.contentWindow?.postMessage(
        { jsonrpc: "2.0", method, params },
        "*",
      );
    const message = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      const data = event.data;
      if (!target || event.source !== target || data?.jsonrpc !== "2.0") return;
      if (data.method === "ui/notifications/initialized") {
        notify("ui/notifications/tool-input", {
          arguments: latest.current.arguments ?? {},
        });
        if (latest.current.result)
          notify("ui/notifications/tool-result", latest.current.result);
        return;
      }
      if (
        data.id === undefined ||
        data.method === "tools/call" ||
        typeof data.method !== "string"
      )
        return;
      const respond = (result: unknown) =>
        target.postMessage({ jsonrpc: "2.0", id: data.id, result }, "*");
      if (data.method === "ui/initialize")
        respond({
          protocolVersion: data.params?.protocolVersion ?? "2026-01-26",
          hostInfo: { name: "Claudex", version: "1" },
          hostCapabilities: { serverTools: {} },
          hostContext: {
            theme:
              document.documentElement.dataset.theme === "light"
                ? "light"
                : "dark",
            displayMode: "inline",
            locale: navigator.language,
          },
        });
      else if (data.method === "ui/request-display-mode") {
        const mode =
          data.params?.mode === "fullscreen" ? "fullscreen" : "inline";
        arrangePane("widget", mode === "fullscreen");
        respond({ mode });
      } else if (data.method === "ui/open-link") {
        if (
          typeof data.params?.url !== "string" ||
          window.navigator.userActivation?.isActive !== true
        ) {
          respond({ isError: true });
        } else {
          openLink(data.params.url);
          respond({});
        }
      } else if (data.method === "ui/message") {
        if (window.navigator.userActivation?.isActive !== true)
          respond({ isError: true });
        else {
          const text =
            typeof data.params?.content === "string"
              ? data.params.content
              : data.params?.content?.[0]?.text;
          if (typeof text === "string" && text.trim())
            app.setText((current) => (current ? `${current}\n${text}` : text));
          respond({});
        }
      } else if (data.method === "tools/list") {
        void api.artifactTools().then(
          (groups) =>
            respond({
              tools:
                groups.find((group) => group.server === latest.current.server)
                  ?.tools ?? [],
            }),
          () => respond({ tools: [] }),
        );
      } else
        target.postMessage(
          {
            jsonrpc: "2.0",
            id: data.id,
            error: { code: -32601, message: "Method not found" },
          },
          "*",
        );
    };
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  }, [app, openLink]);
  useEffect(() => {
    if (item.result)
      frame.current?.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: item.result,
        },
        "*",
      );
  }, [item.result]);
  return (
    <>
      {resource ? (
        <iframe
          ref={frame}
          title={formatText("Widget from {server}", {
            server: resource.server,
          })}
          sandbox="allow-scripts"
          srcDoc={widgetDocument(resource.html, resource)}
        />
      ) : (
        <p role="status">
          {t(error ? "The request failed." : "Rendering widget")}
        </p>
      )}
      {tools}
    </>
  );
}
