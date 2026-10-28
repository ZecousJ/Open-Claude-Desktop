import { useContext, useRef, useState } from "react";
import { Spinner } from "../../ui/Spinner";
import type { Item } from "../../../shared/types";
import {
  resourceName,
  resourceChunkBytes,
  type McpResourceLink,
} from "../../../shared/message-resources";
import { AppContext } from "../../app/AppContext";
import { useConversationServices } from "../../conversation/ConversationServices";
import { t } from "../../i18n";
import "../../ui/markdown-parity.css";

// .
export function ResourceLinkCards({
  item,
  links,
}: {
  item: Item;
  links: McpResourceLink[];
}) {
  const controller = useContext(AppContext);
  const services = useConversationServices();
  const conversationId = services.conversationId ?? controller?.active?.id;
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState(new Set<string>());
  const [error, setError] = useState("");
  async function open(link: McpResourceLink) {
    if (!conversationId || pending.current.has(link.uri)) return;
    pending.current.add(link.uri);
    setBusy(new Set(pending.current));
    setError("");
    try {
      const file = await window.desktop.readMcpResource(
        conversationId,
        item.id,
        link.uri,
      );
      if (file.downloadId) {
        const chunks: string[] = [];
        for (
          let offset = 0;
          offset < file.byteLength!;
          offset += resourceChunkBytes
        )
          chunks.push(
            await window.desktop.readMcpResourceChunk(file.downloadId, offset),
          );
        file.base64 = chunks.join("");
      }
      await window.desktop.saveMcpResourceFile(file);
    } catch (error) {
      setError(
        t(
          error instanceof Error &&
            error.message.includes("This connector is no longer available.")
            ? "Couldn’t fetch the file. This connector is no longer available."
            : "Couldn’t fetch the file. Try again.",
        ),
      );
    } finally {
      pending.current.delete(link.uri);
      setBusy(new Set(pending.current));
    }
  }
  return (
    <div>
      <div className="mcp-resource-links">
        {links.map((link) => {
          const name = resourceName(link);
          const separator = name.lastIndexOf(".");
          const extension =
            separator > 0 && separator < name.length - 1
              ? name.slice(separator + 1)
              : t("file");
          return (
            <button
              type="button"
              key={link.uri}
              className="mcp-resource-link"
              title={link.uri}
              aria-busy={busy.has(link.uri) || undefined}
              onClick={() => void open(link)}
            >
              {busy.has(link.uri) && (
                <Spinner
                  inheritColor
                  size={16}
                  className="mcp-resource-spinner"
                  aria-hidden="true"
                />
              )}
              <span className="mcp-resource-extension" aria-hidden="true">
                {extension}
              </span>
              <bdi>{name}</bdi>
            </button>
          );
        })}
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
