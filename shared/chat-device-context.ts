import { connectorToolOverridesInput } from "./project-tools-input";
import { z } from "zod";
import type { Conversation } from "./types";
import { transcriptDigest } from "./hand-off";
import { chatDeviceMigrationUnavailable } from "./chat-devices-api";

const id = z.string().min(1).max(200);
export const chatDeviceOptionsInput = z
  .object({
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
      .optional(),
    webSearch: z.boolean().optional(),
    research: z.boolean().optional(),
    thinkingMode: z.enum(["standard", "extended"]).optional(),
    connectorOverrides: z.record(z.string().max(200), z.boolean()).optional(),
    connectorToolOverrides: connectorToolOverridesInput.optional(),
  })
  .strict();
export const chatDeviceScopeInput = z.object({
  version: z.literal(1),
  accountScope: id,
  organizationId: z.null(),
});
export const chatDeviceSendInput = chatDeviceScopeInput
  .extend({
    requestId: z.string().uuid(),
    deviceId: id,
    expectedBindingRevision: z.number().int().nonnegative().optional(),
    conversationId: id.optional(),
    text: z.string().min(1).max(200_000),
    mode: z.enum(["chat", "cowork"]),
    providerId: id,
    model: id,
    taskPermission: z.enum(["default", "auto"]),
    attachments: z.array(z.object({ id })).max(12),
    options: chatDeviceOptionsInput.optional(),
  })
  .strict();
export const setChatDeviceInput = chatDeviceScopeInput
  .extend({
    conversationId: id,
    expectedBindingRevision: z.number().int().nonnegative(),
    deviceId: id.nullable(),
    taskPermission: z.enum(["default", "auto"]),
  })
  .strict();

/** The existing imported-history path uses a bounded digest. Only accept
 * history that it can carry completely; rich or larger records stay put. */
export function portableChatDeviceConversation(
  source: Conversation,
): Conversation {
  if (
    source.mode === "code" ||
    source.incognito ||
    source.slim ||
    source.projectId ||
    source.repository ||
    source.scheduledTaskId ||
    source.blankArtifact ||
    source.savedBranches?.length ||
    source.rewind ||
    source.additionalFolders?.length ||
    (source.cwd && source.environment?.kind !== "space") ||
    source.turns.some(
      (turn) =>
        turn.status !== "completed" ||
        turn.shell ||
        turn.compaction ||
        turn.attachments?.length ||
        turn.prompt.trim().length > 1500 ||
        turn.items.length > 1 ||
        turn.items.some(
          (item) =>
            item.type !== "agentMessage" ||
            (item.text?.trim().length ?? 0) > 2500 ||
            item.generatedFiles?.length,
        ),
    )
  )
    throw new Error(chatDeviceMigrationUnavailable);
  const expected = source.turns
    .map((turn) =>
      [
        turn.prompt.trim() && `Person: ${turn.prompt.trim()}`,
        turn.items[0]?.text?.trim() && `Claudex: ${turn.items[0].text.trim()}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
  if (transcriptDigest(source.turns) !== expected)
    throw new Error(chatDeviceMigrationUnavailable);
  const copy = structuredClone(source);
  delete copy.threadId;
  delete copy.cwd;
  delete copy.environment;
  delete copy.chatDeviceBinding;
  delete copy.deviceChatOrigin;
  delete copy.linkedToComputer;
  delete copy.linkedComputerId;
  delete copy.linkedComputerName;
  delete copy.linkedComputerOnline;
  delete copy.linkedComputerAccess;
  copy.importedHistory = true;
  return copy;
}
