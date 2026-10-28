import { useLayoutEffect, useMemo, useRef } from "react";
import type { ConversationRenderState } from "../../shared/mobile/conversation-contract";
import { hostFor } from "../../shared/host";
import { ConversationTranscript } from "../transcript/ConversationTranscript";
import {
  ConversationServicesContext,
  type ConversationServices,
} from "../conversation/ConversationServices";
import { OpenLink, externalUrl } from "../ui/ExternalLinks";
import { HostContext } from "../host/HostContext";
import { ArtifactConversation } from "../artifacts/artifact-metadata";
import { Capabilities } from "../artifacts/capabilities";
import { useTranscriptScroll } from "../transcript/useTranscriptScroll";
import { fileIdentity, rasterDataUrl, rawQuoteSelection } from "./identity";
import { downloadResult, type ConversationBridge } from "./bridge";
import type { Artifact } from "../ui/ArtifactTypes";
import {
  LocalFileLinks,
  localFileResolver,
} from "../transcript/local-file-links";
import { transcriptImageSnapshot } from "./image-snapshots";
import { useActionError } from "./useActionError";
import {
  TranscriptSlots,
  type TranscriptSlotsValue,
} from "../transcript/transcript-slots";
import { OfficialStepsRow } from "./official/OfficialStepsRow";
import {
  OfficialCodeThought,
  OfficialCodeTools,
} from "./official/OfficialCodeTools";
import {
  OfficialCodeReplyActions,
  OfficialScrollLabel,
} from "./official/OfficialCodeReplyActions";
import { OfficialTurnChanges } from "./official/OfficialTurnChanges";
import { OfficialTurnActivity } from "./official/OfficialTurnActivity";
import { SourcesChip } from "./official/SourcesChip";
import { Star } from "../ui/Star";

/** The reference rows the phones draw in Chat; web and desktop keep theirs. */
const officialSlots: TranscriptSlotsValue = {
  StepsGroup: OfficialStepsRow,
  TurnActivity: OfficialTurnActivity,
  ReplyActionsEnd: SourcesChip,
};

/** Code and Cowork end on the same upright mark as Chat. */
const PhoneEndMark = () => <Star size={28} />;
const otherModeSlots: TranscriptSlotsValue = { CodeEndMark: PhoneEndMark };

/**
 * The reference Code session rows the phones draw in Code (the folded tool-call
 * row and its sheets, the turn-edits card, the scroll pill); Cowork keeps the
 * shared rows.
 */
export const codeSlots: TranscriptSlotsValue = {
  CodeEndMark: PhoneEndMark,
  CodeToolGroup: OfficialCodeTools,
  CodeThought: OfficialCodeThought,
  CodeStatusLabels: {
    "Running tools…": "Working…",
    "Waiting for Claudex…": "Working…",
  },
  CodeTurnChanges: OfficialTurnChanges,
  CodeReplyActions: OfficialCodeReplyActions,
  ScrollToLatestLabel: OfficialScrollLabel,
};

export function ConversationSurface({
  state,
  bridge,
  onApplied,
}: {
  state: ConversationRenderState;
  bridge: ConversationBridge;
  onApplied: () => void;
}) {
  const { conversation } = state;
  const { error, dismiss, report, request } = useActionError(
    bridge,
    state.sessionId,
  );
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const tracking = useTranscriptScroll(
    scroll,
    follow,
    conversation,
    conversation.mode,
  );
  const identity = (artifact: Artifact) => {
    const value = fileIdentity(conversation, artifact);
    if (!value)
      throw Error("This file is still arriving or is no longer available");
    return value;
  };
  const services = useMemo<ConversationServices>(
    () => ({
      conversationId: conversation.id,
      inlineArtifactSharing: false,
      copyText: async (text) => {
        await request("copyText", { text });
      },
      attachmentPreviewSync: (id) => {
        const url = state.media?.attachmentPreviews?.[id];
        return rasterDataUrl(url) ? url : null;
      },
      attachmentPreview: async (id) => {
        const url = state.media?.attachmentPreviews?.[id];
        return rasterDataUrl(url) ? url : null;
      },
      openAttachment: async (attachmentId) => {
        try {
          await request("openAttachment", {
            conversationId: conversation.id,
            attachmentId,
          });
        } catch (error) {
          report(error);
        }
      },
      loadRemoteImage: async (url) => {
        if (!externalUrl(url)) throw Error("Invalid image URL");
        const data = await request("loadRemoteImage", { url });
        if (!rasterDataUrl(data))
          throw Error("The image response was not a supported raster image");
        return data;
      },
      readGeneratedFile: async (digest) => {
        const scoped = conversation.turns.some((t) =>
          t.items.some((i) =>
            i.generatedFiles?.some(
              (f) => f.digest === digest && f.state === "ready",
            ),
          ),
        );
        const bytes = scoped && state.media?.generatedFileBytes?.[digest];
        if (
          typeof bytes !== "string" ||
          bytes.length > 24_000_000 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)
        )
          throw Error("Open this file to load its native preview");
        return bytes;
      },
      // Image tools without a captured canonical generatedFile keep their shared
      // status rows. Native owns filesystem discovery and can supply a snapshot.
      imageGenerationSnapshot: async (path) =>
        transcriptImageSnapshot(conversation, path),
      viewedImageSnapshot: async (id, path) =>
        id === conversation.id
          ? transcriptImageSnapshot(conversation, path, true)
          : null,
      downloadArtifact: async (artifact) => {
        const result = await request("downloadArtifact", identity(artifact));
        return typeof result === "string" ? result : null;
      },
      downloadArtifacts: async (artifacts) => {
        const files = artifacts.map(identity);
        const result = await request("downloadArtifacts", {
          conversationId: conversation.id,
          files,
        });
        return downloadResult(result, files.length).saved;
      },
    }),
    [request, report, conversation, state.media],
  );
  useLayoutEffect(onApplied, [state.revision, onApplied]);
  return (
    <HostContext.Provider value={hostFor("web")}>
      <TranscriptSlots.Provider
        value={
          conversation.mode === "chat"
            ? officialSlots
            : conversation.mode === "code"
              ? codeSlots
              : otherModeSlots
        }
      >
        <ConversationServicesContext.Provider value={services}>
          <Capabilities.Provider
            value={{ aiArtifacts: false, inlineVisualizations: false }}
          >
            <OpenLink.Provider
              value={(url) => {
                if (externalUrl(url))
                  void request("openLink", { url }).catch(report);
              }}
            >
              <ArtifactConversation.Provider value={conversation.id}>
                <LocalFileLinks.Provider
                  value={localFileResolver(conversation)}
                >
                  <div
                    className={`app web sidebar-hidden mobile-conversation mode-${conversation.mode}`}
                  >
                    <main className="workspace has-conversation">
                      <div className="chat-layout">
                        <div className="chat-main">
                          {error && (
                            <div
                              className="mobile-conversation-error"
                              role="alert"
                            >
                              {error}
                              <button
                                onClick={dismiss}
                                aria-label="Dismiss error"
                              >
                                ×
                              </button>
                            </div>
                          )}
                          <ConversationTranscript
                            conversation={conversation}
                            mode={conversation.mode}
                            sending={!!state.sending}
                            running={conversation.turns.some(
                              (t) => t.status === "inProgress",
                            )}
                            approvals={[]}
                            replyFeedback={state.replyFeedback ?? {}}
                            onReplyFeedback={async (turnId, rating) => {
                              await request("replyFeedback", {
                                conversationId: conversation.id,
                                turnId,
                                rating,
                              });
                            }}
                            onArtifact={(artifact) => {
                              try {
                                void request(
                                  "openArtifact",
                                  identity(artifact),
                                ).catch(report);
                              } catch (error) {
                                report(error);
                              }
                            }}
                            onOpenWorkflow={() =>
                              void request("openWorkflow", {
                                conversationId: conversation.id,
                              }).catch(report)
                            }
                            onOpenAgent={(target) =>
                              void request("openAgent", {
                                conversationId: conversation.id,
                                agentId: target.agentId,
                              }).catch(report)
                            }
                            onEditPrompt={async (turnId, text) => {
                              try {
                                const result = await request("editPrompt", {
                                  conversationId: conversation.id,
                                  turnId,
                                  text,
                                });
                                return result !== false;
                              } catch (error) {
                                report(error);
                                return false;
                              }
                            }}
                            onRetryResponse={(turnId) =>
                              void request("retryResponse", {
                                conversationId: conversation.id,
                                turnId,
                              }).catch(report)
                            }
                            onContinue={() =>
                              void request("continueResponse", {
                                conversationId: conversation.id,
                              }).catch(report)
                            }
                            onSelectVersion={(turnId, versionId, prompt) =>
                              void request("selectVersion", {
                                conversationId: conversation.id,
                                turnId,
                                versionId,
                                prompt,
                              }).catch(report)
                            }
                            onError={report}
                            onOpenChanges={() =>
                              void request("openChanges", {
                                conversationId: conversation.id,
                              }).catch(report)
                            }
                            onOpenPlan={() =>
                              void request("openPlan", {
                                conversationId: conversation.id,
                              }).catch(report)
                            }
                            onQuoteReply={(quote) => {
                              const text = rawQuoteSelection(quote);
                              void request("quoteReply", {
                                conversationId: conversation.id,
                                text,
                              }).catch(report);
                            }}
                            scrollRef={scroll}
                            onScroll={tracking.onScroll}
                            onWheel={tracking.onWheel}
                            away={tracking.away}
                            onJumpToLatest={tracking.jumpToLatest}
                          />
                        </div>
                      </div>
                    </main>
                  </div>
                </LocalFileLinks.Provider>
              </ArtifactConversation.Provider>
            </OpenLink.Provider>
          </Capabilities.Provider>
        </ConversationServicesContext.Provider>
      </TranscriptSlots.Provider>
    </HostContext.Provider>
  );
}
