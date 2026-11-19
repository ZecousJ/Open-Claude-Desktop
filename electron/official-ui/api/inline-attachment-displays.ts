import { z } from "zod";
import { createHash } from "node:crypto";
import {
  inlineAttachmentDisplaySchema,
  inlineDisplayKey,
  promptKey,
  parseInlineAttachmentDisplays,
  type InlineQuoteSource,
} from "../../../shared/inline-attachment-display";
import type { Attachment, Conversation, Turn } from "../../../shared/types";
import {
  inlineQuoteSource,
  verifyInlineDisplayBytes,
} from "../../conversations/inline-attachment-display";
import { organizationUuid, type AdapterContext } from "./context";
import { knownFile } from "./files";
import { resolveCompletionQuoteSources } from "./completion-quote-source";
import { currentAdapterScope } from "./scope";
import { prepareDerivedTextAttachment } from "./derived-text-attachment";

export function inlineDisplayForSend(
  attachmentId: string,
  display: { file_name: string; file_type: string; kind?: string },
  text: string,
  quoteSource?: InlineQuoteSource,
) {
  return inlineAttachmentDisplaySchema.parse({
    version: 1,
    attachmentId,
    fileName: display.file_name,
    fileType: display.file_type,
    ...(display.kind ? { kind: display.kind } : {}),
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text).digest("hex"),
    ...(quoteSource ? { quoteSource } : {}),
  });
}
export interface InlineDisplayAnswer {
  file_name: string;
  file_type: string;
  file_size: number;
  extracted_content: string;
  kind?: string;
  quote_message_uuid?: string;
}
export type InlineDisplayProjection = Map<string, InlineDisplayAnswer> & {
  fileNames?: ReadonlyMap<string, string>;
};

const projectedDisplaySchema = z
  .object({
    turnId: z.string().min(1).max(200),
    attachmentName: z.string().min(1).max(1000),
    display: inlineAttachmentDisplaySchema,
  })
  .strict();
type ProjectedDisplay = z.infer<typeof projectedDisplaySchema>;
type MessageIds = { user(turn: Turn): string; assistant(turn: Turn): string };

/** Read-only declarations for the owning Runner's existing history transport. */
export function inlineDisplayHistory(
  conversation: Conversation,
  projection: InlineDisplayProjection,
  ids: MessageIds,
): ProjectedDisplay[] {
  const seen = new Set<string>();
  return [
    ...(conversation.savedBranches ?? []).flatMap((branch) => branch.turns),
    ...conversation.turns,
  ].flatMap((turn) =>
    "inlineAttachmentDisplays" in turn
      ? []
      : turn.attachments.flatMap((attachment) => {
          const key = inlineDisplayKey(turn.id, attachment.id);
          const value = projection.get(key);
          if (!value || seen.has(key)) return [];
          seen.add(key);
          const source = value.quote_message_uuid
            ? resolveCompletionQuoteSources(
                {
                  conversation,
                  current: () => true,
                  userMessageId: ids.user,
                  assistantMessageId: ids.assistant,
                },
                [
                  {
                    passage: {
                      case: "excerpt",
                      value: {
                        text: value.extracted_content,
                        targetMessageId: value.quote_message_uuid,
                      },
                    },
                  },
                ],
              ).sources[0].source
            : undefined;
          return [
            {
              turnId: turn.id,
              attachmentName: attachment.name,
              display: inlineDisplayForSend(
                attachment.id,
                value,
                value.extracted_content,
                source,
              ),
            },
          ];
        }),
  );
}

async function remoteInlineDisplays(
  ctx: AdapterContext,
  conversation: Conversation,
): Promise<ProjectedDisplay[]> {
  if (!conversation.cloudHosted || !ctx.readWorkspaceDownload) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      ctx.readWorkspaceDownload({
        method: "GET",
        path: `/api/organizations/${organizationUuid(ctx.account()!.id)}/chat_conversations/${conversation.id}?claudex_inline_displays=1`,
      }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 5000);
      }),
    ]);
    if (
      answer?.status !== 200 ||
      !(answer.body instanceof Uint8Array) ||
      answer.body.byteLength > 4 * 1024 * 1024 ||
      !/^application\/json(?:;|$)/i.test(answer.contentType)
    )
      return [];
    const parsed = z
      .object({
        uuid: z.literal(conversation.id),
        claudex_inline_attachment_displays: z
          .array(projectedDisplaySchema)
          .max(5000 * 12),
      })
      .safeParse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(answer.body),
        ),
      );
    return parsed.success ? parsed.data.claudex_inline_attachment_displays : [];
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function legacyDisplay(conversationId: string, attachment: Attachment) {
  const file = knownFile(attachment.id);
  return file?.id === attachment.id &&
    file.conversationId === conversationId &&
    file.name === attachment.name &&
    file.size === attachment.size
    ? file.inlineDisplay
    : undefined;
}

/** Canonical declarations win. Absent fields retain verified legacy file-level semantics. */
export async function projectInlineAttachmentDisplays(
  ctx: AdapterContext,
  conversation: Conversation,
  ids: MessageIds,
): Promise<InlineDisplayProjection> {
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.(),
    root = ctx.stateDirectory?.(),
    scope = currentAdapterScope();
  const check = () => {
    if (
      !owner ||
      scope.owner !== owner ||
      identity == null ||
      !root ||
      currentAdapterScope() !== scope ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== identity ||
      ctx.stateDirectory?.() !== root ||
      ctx.isCurrent?.() === false
    )
      throw Error("The attachment account changed.");
  };
  check();
  const fileNames = new Map<string, string>();
  const result = Object.assign(new Map<string, InlineDisplayAnswer>(), { fileNames });
  let bytes = 0;
  const turns = [
    ...(conversation.savedBranches ?? []).flatMap((branch) => branch.turns),
    ...conversation.turns,
  ];
  if (
    turns.length > 5000 ||
    turns.some(
      (turn) =>
        !Array.isArray(turn.attachments) ||
        turn.attachments.length > 12 ||
        turn.attachments.some(
          (file) =>
            !file ||
            typeof file.id !== "string" ||
            typeof file.name !== "string" ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0,
        ) ||
        new Set(turn.attachments.map((file) => file.id)).size !==
          turn.attachments.length,
    )
  )
    return result;
  const declarations = new Map<
    Turn,
    ReturnType<typeof parseInlineAttachmentDisplays>
  >();
  const signatures = new Map<string, string>(),
    conflicts = new Set<string>();
  for (const turn of turns) {
    let displays: ReturnType<typeof parseInlineAttachmentDisplays> = [];
    try {
      displays = parseInlineAttachmentDisplays(
        turn.inlineAttachmentDisplays ?? [],
        turn.attachments.map((file) => file.id),
      );
    } catch {}
    declarations.set(turn, displays);
    const signature = JSON.stringify([
      "inlineAttachmentDisplays" in turn ? "canonical" : "legacy",
      [...displays].sort((a, b) =>
        a.attachmentId.localeCompare(b.attachmentId),
      ),
    ]);
    const key = promptKey(turn),
      prior = signatures.get(key);
    if (prior !== undefined && prior !== signature) conflicts.add(key);
    signatures.set(key, signature);
  }
  const needsRemote = turns.some(
    (turn) =>
      !("inlineAttachmentDisplays" in turn) &&
      turn.attachments.some(
        (attachment) => !legacyDisplay(conversation.id, attachment),
      ),
  );
  const remote = needsRemote
    ? await remoteInlineDisplays(ctx, conversation)
    : [];
  check();
  const contents = new Map<string, Uint8Array>();
  for (const turn of turns) {
    if (conflicts.has(promptKey(turn))) continue;
    const candidates: {
      display: ReturnType<typeof inlineAttachmentDisplaySchema.parse>;
      quoteMessageId?: string;
    }[] = declarations.get(turn)!.map((display) => ({ display }));
    if (!("inlineAttachmentDisplays" in turn)) {
      for (const attachment of turn.attachments) {
        const legacy = legacyDisplay(conversation.id, attachment);
        if (legacy) {
          const parsed = inlineAttachmentDisplaySchema.safeParse({
            version: 1,
            attachmentId: attachment.id,
            fileName: legacy.file_name,
            fileType: legacy.file_type,
            bytes: attachment.size,
            sha256: legacy.sha256,
            ...(legacy.kind === undefined ? {} : { kind: legacy.kind }),
          });
          if (
            parsed.success &&
            (legacy.quote_message_uuid === undefined ||
              (legacy.kind === "excerpt" &&
                typeof legacy.quote_message_uuid === "string" &&
                !!legacy.quote_message_uuid))
          )
            candidates.push({
              display: parsed.data,
              quoteMessageId: legacy.quote_message_uuid,
            });
        } else {
          const matches = remote.filter(
            (row) =>
              row.turnId === turn.id &&
              row.display.attachmentId === attachment.id,
          );
          if (
            matches.length &&
            matches.every(
              (row) => JSON.stringify(row) === JSON.stringify(matches[0]),
            ) &&
            matches[0].attachmentName === attachment.name &&
            matches[0].display.bytes === attachment.size
          )
            candidates.push({ display: matches[0].display });
        }
      }
    }
    for (const candidate of candidates) {
      let display = candidate.display;
      const key = inlineDisplayKey(turn.id, display.attachmentId);
      if (result.has(key)) continue;
      const attachment = turn.attachments.find(
        (file) => file.id === display.attachmentId,
      )!;
      try {
        let data = contents.get(attachment.id);
        if (!data) {
          if (bytes + display.bytes > 3 * 1024 * 1024) {
            if ("inlineAttachmentDisplays" in turn && !display.quoteSource && display.kind !== "excerpt" &&
                attachment.kind === "text" && attachment.size === display.bytes &&
                prepareDerivedTextAttachment({ ...display, extractedContent: "" }).name === attachment.name)
              fileNames.set(key, display.fileName);
            continue;
          }
          check();
          const answer: unknown = await ctx.call(
            "turnAttachment",
            conversation.id,
            attachment.id,
          );
          check();
          if (
            !answer ||
            typeof answer !== "object" ||
            !("data" in answer) ||
            !(answer.data instanceof Uint8Array) ||
            answer.data.byteLength > 2 * 1024 * 1024 ||
            bytes + answer.data.byteLength > 3 * 1024 * 1024
          )
            continue;
          data = answer.data;
          bytes += data.byteLength;
          contents.set(attachment.id, data);
        }
        const text = verifyInlineDisplayBytes(
          display,
          attachment,
          data,
          conversation,
        );
        if (candidate.quoteMessageId) {
          const quoteSource = resolveCompletionQuoteSources(
            {
              conversation,
              current: () => {
                check();
                return true;
              },
              userMessageId: ids.user,
              assistantMessageId: ids.assistant,
            },
            [
              {
                passage: {
                  case: "excerpt",
                  value: { text, targetMessageId: candidate.quoteMessageId },
                },
              },
            ],
          ).sources[0].source;
          display = inlineAttachmentDisplaySchema.parse({
            ...display,
            quoteSource,
          });
          verifyInlineDisplayBytes(display, attachment, data, conversation);
        }
        const source = display.quoteSource
          ? inlineQuoteSource(conversation, display.quoteSource)
          : undefined;
        result.set(key, {
          file_name: display.fileName,
          file_type: display.fileType,
          file_size: display.bytes,
          extracted_content: text,
          ...(display.kind ? { kind: display.kind } : {}),
          ...(source && display.quoteSource
            ? {
                quote_message_uuid:
                  display.quoteSource.role === "user"
                    ? ids.user(source)
                    : ids.assistant(source),
              }
            : {}),
        });
        if (!display.quoteSource && display.kind !== "excerpt") fileNames.set(key, display.fileName);
      } catch {
        check();
      }
    }
  }
  check();
  return result;
}
