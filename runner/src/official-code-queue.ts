import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import type { Attachment, Conversation } from "../../shared/types";
import { skillReferencesSchema } from "../../shared/skill-references";
import { codeEffortInput } from "../../electron/ipc/code-model-preferences";
import {
  syncOfficialStateDirectory,
  writeOfficialStateFile,
} from "./official-ui-receipts";

const attachment = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .refine(
      (name) => path.basename(name) === name && name !== "." && name !== "..",
    ),
  size: z.number().int().nonnegative(),
  kind: z.enum(["image", "text", "document"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  retainOnCancel: z.literal(true).optional(),
});
export const queuedCodeModelChoice = z.strictObject({
  providerId: z.string().min(1).max(200), model: z.string().min(1).max(200), effort: codeEffortInput.optional(),
});
const input = z.object({
  eventId: z.string().uuid(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string(),
  skillReferences: skillReferencesSchema.optional(),
  sendText: z.string().optional(),
  modelSettings: z.literal(true).optional(),
  choice: queuedCodeModelChoice.optional(),
  priority: z.enum(["next", "later"]),
  createdAt: z.number(),
  after: z.object({ id: z.string(), createdAt: z.number() }).optional(),
  state: z.enum(["queued", "held", "dispatching", "steering"]),
  attachments: z.array(attachment).max(12),
});
const document = z.object({
  sessionCreatedAt: z.number(),
  inputs: z.array(input),
});

export type StoredCodeInput = z.infer<typeof input>;

const queueFile = (root: string, owner: string, conversation: Conversation) =>
  path.join(
    root,
    "official-code-queue-" + cloudCodeSessionKey(conversation, owner) + ".json",
  );

export function readCodeQueue(
  root: string,
  owner: string,
  conversation: Conversation,
) {
  const file = queueFile(root, owner, conversation);
  if (!fs.existsSync(file)) return [];
  const saved = document.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return saved.sessionCreatedAt === conversation.createdAt ? saved.inputs : [];
}

export function writeCodeQueue(
  root: string,
  owner: string,
  conversation: Conversation,
  inputs: Iterable<StoredCodeInput>,
) {
  const file = queueFile(root, owner, conversation);
  const saved = [...inputs];
  if (saved.length) {
    writeOfficialStateFile(file, {
      sessionCreatedAt: conversation.createdAt,
      inputs: saved,
    });
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    syncOfficialStateDirectory(root);
  }
}

export function queuedCodeAttachmentIds(
  root: string,
  owner: string,
  conversations: Conversation[],
) {
  return conversations
    .filter((conversation) => isOwnedCloudCodeSession(conversation, owner))
    .flatMap((conversation) =>
      readCodeQueue(root, owner, conversation).flatMap((input) =>
        input.attachments.map((file) => file.id),
      ),
    );
}

export function queuedCodeAttachment(
  root: string,
  { id, name, size, kind }: z.infer<typeof attachment>,
): Attachment {
  return {
    id, name, size, kind,
    path: path.join(root, "attachments", id, name),
  };
}

export function syncQueuedCodeAttachments(
  root: string,
  files: readonly Attachment[],
) {
  if (!files.length) return;
  for (const file of files) {
    const fd = fs.openSync(file.path, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncOfficialStateDirectory(path.dirname(file.path));
  }
  syncOfficialStateDirectory(path.join(root, "attachments"));
}
