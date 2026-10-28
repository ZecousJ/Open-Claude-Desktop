import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  artifactToolMessage,
  artifactToolResult,
  type ArtifactToolRequest,
} from "../../shared/artifact-tools";
import { ArtifactToolDialog } from "./ArtifactToolDialog";

export function useArtifactTools(
  frame: RefObject<HTMLIFrameElement | null>,
  identity: string,
  version: string,
  widgetServer?: string,
) {
  const [queue, setQueue] = useState<
    {
      request: ArtifactToolRequest;
      decide: (allow: boolean) => Promise<void>;
    }[]
  >([]);
  useEffect(() => {
    let live = true;
    const pending = new Set<string>();
    const inFlight = new Set<number | string>();
    setQueue([]);
    async function message(event: MessageEvent) {
      const target = frame.current?.contentWindow;
      const rpc =
        widgetServer &&
        event.data?.jsonrpc === "2.0" &&
        event.data?.method === "tools/call";
      if (widgetServer && !rpc) return;
      const data = rpc
        ? {
            type: artifactToolMessage,
            id: event.data.id,
            method: "callTool",
            args: [
              widgetServer,
              event.data.params?.name,
              event.data.params?.arguments ?? {},
            ],
          }
        : event.data;
      if (!widgetServer && data?.method === "runScheduledTask") return;
      if (
        !target ||
        event.source !== target ||
        data?.type !== artifactToolMessage ||
        !(
          Number.isSafeInteger(data.id) ||
          (typeof data.id === "string" && data.id.length <= 200)
        ) ||
        !Array.isArray(data.args) ||
        inFlight.has(data.id) ||
        inFlight.size >= 16
      )
        return;
      inFlight.add(data.id);
      const answer = (value: { result?: unknown; error?: string }) => {
        inFlight.delete(data.id);
        if (live && frame.current?.contentWindow === target)
          target.postMessage(
            rpc
              ? {
                  jsonrpc: "2.0",
                  id: data.id,
                  ...(value.error
                    ? { error: { code: -32603, message: value.error } }
                    : { result: value.result }),
                }
              : { type: artifactToolResult, id: data.id, ...value },
            "*",
          );
      };
      try {
        if (
          data.method === "listTools" ||
          data.method === "serverTools" ||
          data.method === "describeTool"
        ) {
          const groups = await window.desktop.artifactTools();
          const server = groups.find((group) => group.server === data.args[0]);
          answer({
            result:
              data.method === "listTools"
                ? {
                    servers: groups.map((group) => ({
                      ...group,
                      authStatus: "connected",
                    })),
                  }
                : data.method === "serverTools"
                  ? server
                  : server?.tools.find((tool) => tool.name === data.args[1]),
          });
          return;
        }
        if (data.method !== "callTool") throw new Error("The request failed.");
        const [server, tool, input, options] = data.args;
        if (widgetServer && server !== widgetServer)
          throw new Error("The request failed.");
        const request = await window.desktop.requestArtifactTool(identity, {
          server,
          tool,
          input,
          ...(Array.isArray(options?.groups) ? { groups: options.groups } : {}),
        });
        if (!live || frame.current?.contentWindow !== target) {
          void window.desktop
            .respondArtifactTool(request.id, false)
            .catch(() => {});
          return;
        }
        pending.add(request.id);
        const decide = async (allow: boolean) => {
          if (!pending.delete(request.id)) return;
          setQueue((items) =>
            items.filter((item) => item.request.id !== request.id),
          );
          try {
            const result = await window.desktop.respondArtifactTool(
              request.id,
              allow,
            );
            answer({ result });
          } catch (error) {
            answer({
              error:
                error instanceof Error ? error.message : "The request failed.",
            });
          }
        };
        if (request.permitted) void decide(true);
        else setQueue((items) => [...items, { request, decide }]);
      } catch (error) {
        answer({
          error: error instanceof Error ? error.message : "The request failed.",
        });
      }
    }
    window.addEventListener("message", message);
    return () => {
      live = false;
      window.removeEventListener("message", message);
      for (const id of pending)
        void window.desktop.respondArtifactTool(id, false).catch(() => {});
    };
  }, [frame, identity, version, widgetServer]);
  const current = queue[0];
  return (
    current &&
    createPortal(
      <ArtifactToolDialog
        key={current.request.id}
        request={current.request}
        busy={false}
        onDecision={(allow) => void current.decide(allow)}
      />,
      document.body,
    )
  );
}
