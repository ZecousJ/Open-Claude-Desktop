import { useLayoutEffect, useMemo } from "react";
import type { ConversationDocumentState } from "../../shared/mobile/conversation-contract";
import { Markdown } from "../ui/Markdown";
import { OpenLink, externalUrl } from "../ui/ExternalLinks";
import {
  ConversationServicesContext,
  type ConversationServices,
} from "../conversation/ConversationServices";
import type { ConversationBridge } from "./bridge";
import { rasterDataUrl } from "./identity";
import { useActionError } from "./useActionError";

export function documentMarkdown(language: string, content: string) {
  if (["markdown", "md"].includes(language.toLowerCase())) return content;
  const fence = "`".repeat(
    Math.max(3, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length + 1)),
  );
  return `${fence}${/^[\w+.-]+$/.test(language) ? language : "text"}\n${content}\n${fence}`;
}
export function DocumentSurface({
  state,
  bridge,
  onApplied,
}: {
  state: ConversationDocumentState;
  bridge: ConversationBridge;
  onApplied: () => void;
}) {
  const { error, dismiss, report, request } = useActionError(
    bridge,
    state.sessionId,
  );
  const services = useMemo<ConversationServices>(
    () => ({
      copyText: async (text) => {
        await request("copyText", { text });
      },
      attachmentPreview: async () => null,
      readGeneratedFile: async () => {
        throw Error("No file read capability in document preview");
      },
      imageGenerationSnapshot: async () => null,
      viewedImageSnapshot: async () => null,
      loadRemoteImage: async (url) => {
        const value = await request("loadRemoteImage", { url });
        if (!rasterDataUrl(value)) throw Error("Unsupported image response");
        return value;
      },
    }),
    [request],
  );
  useLayoutEffect(onApplied, [state.revision, onApplied]);
  return (
    <ConversationServicesContext.Provider value={services}>
      <OpenLink.Provider
        value={(url) => {
          if (externalUrl(url)) void request("openLink", { url }).catch(report);
        }}
      >
        <main className="mobile-document mode-chat">
          {error && (
            <div className="mobile-conversation-error" role="alert">
              {error}
              <button onClick={dismiss} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          <div className="markdown">
            <Markdown
              text={documentMarkdown(
                state.document.language,
                state.document.content,
              )}
            />
          </div>
        </main>
      </OpenLink.Provider>
    </ConversationServicesContext.Provider>
  );
}
