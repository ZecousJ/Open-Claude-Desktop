/**
 * Composer calls for the preview: pasted files become attachments without
 * touching disk, `@` lists a fixed set of paths, a running turn does not take
 * steered messages (so they queue), and /compact answers with the conversation
 * unchanged. Nothing is sent anywhere.
 */
import type { Attachment } from "../../../shared/types";
import type { MentionFile } from "../../../shared/composer-api";
import { countLines } from "../../../shared/attachment-detail";
import type { FixtureDomain } from "./index";

const paths: MentionFile[] = [
  { path: "src", kind: "folder" },
  { path: "src/app/App.tsx", kind: "file" },
  { path: "src/composer/Composer.tsx", kind: "file" },
  { path: "src/composer/ContextRing.tsx", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "package.json", kind: "file" },
];

export const composerFixture: FixtureDomain = {
  params: {},
  bridge: ({ state }) => {
    let count = 0;
    const conversation = (id: string) => {
      const found = state.conversations.find((c) => c.id === id);
      if (!found) throw new Error("Conversation not found.");
      return structuredClone(found);
    };
    return {
      compactConversation: async (id) => conversation(id),
      steerTurn: async () => null,
      addAttachmentData: async (name, data, options) =>
        ({
          id: `fixture-attachment-${++count}`,
          name,
          // ?platform=win32 gives Windows paths (C:\Users\…), R-0380.
          path:
            state.platform === "win32"
              ? `C:\\Users\\fixture\\attachments\\${name}`
              : `/Users/fixture/attachments/${name}`,
          size: data.byteLength,
          kind: /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : "text",
          ...(options?.pasted ? { pasted: true } : {}),
          ...(/\.(png|jpe?g|gif|webp)$/i.test(name)
            ? {}
            : { lines: countLines(data) }),
        }) satisfies Attachment,
      attachmentPreview: async () => null,
      mentionFiles: async (_scope, query) =>
        paths.filter((file) =>
          file.path.toLowerCase().includes(query.toLowerCase()),
        ),
      listSlashCommands: async () => ({
        commands: [
          {
            name: "review-pr",
            description: "Review the open pull request",
            source: "prompt",
            argumentHint: "[pr-number]",
          },
          {
            name: "skill-creator",
            description: "Create or update a skill",
            source: "skill",
          },
          // A plugin's skills keep their prefix and carry no tag.
          {
            name: "anthropic-skills:docs",
            description: "Living documents",
            source: "skill",
          },
          {
            name: "advisor-notes",
            description: "Ask for advice",
            source: "prompt",
          },
        ],
        usageCredits: true,
      }),
      readCustomPrompt: async (name) =>
        name === "review-pr" ? "Review pull request $1." : null,
    };
  },
};
