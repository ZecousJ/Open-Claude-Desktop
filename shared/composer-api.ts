/**
 * Composer calls: attachments added by pasting or dropping, image thumbnails, @
 * file mentions, compact and steer. Handlers go in `electron/ipc/composer.ts`.
 */
import type { Attachment, Conversation, EnvironmentRef } from "./types";
import { bridgeMethods } from "./bridge-methods";

/**
 * What `/review` looks at (Codex's `ReviewTarget`): the working tree's
 * uncommitted changes, the branch against a base branch, one commit, or
 * whatever the instructions ask for.
 */
export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

declare module "./types" {
  interface Turn {
    /**
     * A `/review` turn (`startReview`): Codex reviews the target in the
     * session's thread. Its prompt is the line the person typed; the turn
     * holds Codex's `enteredReviewMode` and `exitedReviewMode` items, the
     * second carrying the review text. It cannot be retried or edited.
     */
    review?: ReviewTarget;
  }
  interface Attachment {
    /** Long text pasted into the composer, kept as a text file. */
    pasted?: boolean;
    /** Lines in a text file, counted when it is added. */
    lines?: number;
  }
}

/** A message `steerTurn` handed to the running turn. */
export interface SteerResult {
  /**
   * The id the message's item carries (`SteeredMessageItem.clientId`, see
   * shared/agent-api.ts) once Codex hands it to the model.
   */
  messageId: string;
  conversation: Conversation;
}

/** Where `@` looks for files: a conversation's working folder, or a chosen folder. */
export interface MentionScope {
  conversationId?: string;
  /** A folder the person chose with the folder picker (a new Code session). */
  folder?: string;
  /** Where `folder` is: missing means this computer (R9: an SSH host's). */
  environment?: EnvironmentRef;
}

/** A path under the scope's folder: relative, with `/` separators. */
export interface MentionFile {
  path: string;
  kind: "file" | "folder";
}

/**
 * A slash command the person added: a Codex custom prompt
 * (`$CODEX_HOME/prompts/<name>.md`, "Personal") or an enabled skill.
 */
export interface CustomSlashCommand {
  name: string;
  description: string;
  source: "prompt" | "skill";
  /** A prompt's `argument-hint` front matter. */
  argumentHint?: string;
}

/** What the Code slash palette lists besides its built-in commands. */
export interface SlashCommandList {
  commands: CustomSlashCommand[];
  /** /usage-credits: a Sub2API account, whose Billing page shows its credits. */
  usageCredits: boolean;
}

export interface ComposerAPI {
  resolveCodeNewTask(
    conversationId: string,
    offerId: string,
    choice: "here" | "new_session",
    remember?: boolean,
  ): Promise<Conversation>;
  linkChatGitHubRepository(
    repository: string,
    branch: string,
  ): Promise<Attachment>;
  /**
   * /compact: Codex summarizes the conversation so far into a shorter context
   * (`thread/compact/start`). Resolves once the compaction turn is recorded
   * (a turn with `compaction: "manual"`); its progress and end arrive as
   * conversation events. Refused while the conversation is running.
   */
  compactConversation(conversationId: string): Promise<Conversation>;
  /**
   * Bash mode: runs `command` as a shell command in the Code session
   * (`thread/shellCommand`) instead of sending it to the model. Resolves
   * once the command's turn is recorded (a turn with `shell: true`); its
   * output arrives as conversation events. Refused while the conversation
   * is running.
   */
  runShellCommand(
    conversationId: string,
    command: string,
  ): Promise<Conversation>;
  /**
   * Fork session / Fork from here: a new conversation that continues this
   * one after `turnId` (its last finished turn when omitted) on a fork of
   * its thread; this one stays as it is and records the fork. With a
   * `prompt` (`/fork <prompt>`, Send in a forked session) the new
   * conversation sends it at once. Resolves with the new conversation.
   * Refused for incognito chats and running replies.
   */
  forkConversation(
    conversationId: string,
    options?: { turnId?: string; prompt?: string },
  ): Promise<Conversation>;
  /**
   * Hand off to a new session: a new Code session that starts from a note
   * about this one. The note is written on an ephemeral fork of the thread
   * (as a side chat is answered; when the session is too long to answer
   * from, an excerpt of its latest messages stands in) and sent as the new
   * session's first message, which only asks it to say where things stand.
   * The new session links back ("Handed off from {title}") and this one
   * records it under its last turn; this one stays as it is. Resolves with
   * the new conversation. Refused for incognito chats, Chat and Cowork, and
   * while a reply is running.
   */
  handOffConversation(conversationId: string): Promise<Conversation>;
  /**
   * Side chat: asks `question` about the conversation without touching it.
   * The question runs on an ephemeral fork of the conversation's thread
   * (made on the side chat's first question, at the last finished turn), so
   * the model sees the conversation so far and nothing said here is added to
   * it. `sideChatId` names the side chat (the window makes one per open
   * conversation); its questions share the fork. Resolves with the answer;
   * the answer so far also arrives as "side-chat-text" events while it is
   * being written.
   * Works while the conversation is running; refused before it has a
   * finished turn.
   */
  askSideChat(
    conversationId: string,
    sideChatId: string,
    question: string,
  ): Promise<string>;
  /**
   * Stops the side chat's question that is being answered (Stop): the answer
   * written so far is what `askSideChat` then resolves with, or it rejects
   * when there is none. Quiet when nothing is being answered.
   */
  interruptSideChat(conversationId: string, sideChatId: string): Promise<void>;
  /**
   * Ends a side chat (Clear): a question still being answered is stopped
   * and the fork is released. Quiet when it is already gone.
   */
  endSideChat(conversationId: string, sideChatId: string): Promise<void>;
  /**
   * `/review` (Codex `review/start`, inline): Codex reviews the target in
   * this session's thread and answers with its findings. `prompt` is what the
   * person typed and what the turn shows. Resolves once the review's turn is
   * recorded (a turn with `review`); its progress and end arrive as
   * conversation events. Refused while the conversation is running.
   */
  startReview(
    conversationId: string,
    target: ReviewTarget,
    prompt?: string,
  ): Promise<Conversation>;
  /**
   * Rewind to here / `/rewind`: removes a message and everything after it
   * (the last message when `turnId` is omitted); the files stay as they are.
   * What it removed is kept for Undo rewind (`swapRewind`) until the next
   * message. Refused while the conversation is running.
   */
  rewindConversation(
    conversationId: string,
    turnId?: string,
  ): Promise<Conversation>;
  /** Undo rewind / Redo rewind: swaps the set-aside turns back in. */
  swapRewind(conversationId: string): Promise<Conversation>;
  /**
   * Rewind's "Code" restore (shared/rewind-files.ts): undoes the file edits
   * Claude made from this message on, in a local Code session's folder.
   * Desktop only.
   */
  restoreRewindCode(
    conversationId: string,
    turnId: string,
  ): Promise<{ restored: number; skipped: number }>;
  /**
   * Adds a message to the conversation's running turn (`turn/steer`); the
   * model reads it at its next step. null when no turn can take it now (the
   * conversation is idle, its turn is still starting or compacting, or it
   * just ended): send it as a new message instead. Attachments are ids from
   * the file picker, as for `send`.
   */
  steerTurn(
    conversationId: string,
    text: string,
    attachmentIds: string[],
  ): Promise<SteerResult | null>;
  /**
   * Keeps a pasted or dropped file (or long pasted text, `pasted: true`) in
   * the account's folder and returns it as an attachment, under the same
   * type and size rules as the file picker.
   */
  addAttachmentData(
    name: string,
    data: Uint8Array,
    options?: { pasted?: boolean },
  ): Promise<Attachment>;
  /** A `data:` URL of an attached image for its thumbnail; null for other files. */
  attachmentPreview(attachmentId: string): Promise<string | null>;
  /**
   * Files and folders under the scope's folder whose path matches `query`
   * (at most 50). Never lists outside the folder: `..`, absolute paths and
   * links that leave it are refused.
   */
  mentionFiles(scope: MentionScope, query: string): Promise<MentionFile[]>;
  /**
   * Custom prompts and the skills enabled for the scope's folder, for the
   * Code slash palette. Prompt files over 64 KB, not UTF-8, or named so
   * they can't be typed after "/" are left out.
   */
  listSlashCommands(scope: MentionScope): Promise<SlashCommandList>;
  /** A custom prompt's body without its front matter; null once it is gone. */
  readCustomPrompt(name: string): Promise<string | null>;
}

export const composerMethods = bridgeMethods<ComposerAPI>({
  resolveCodeNewTask: true,
  linkChatGitHubRepository: true,
  compactConversation: true,
  forkConversation: true,
  handOffConversation: true,
  askSideChat: true,
  interruptSideChat: true,
  endSideChat: true,
  startReview: true,
  runShellCommand: true,
  rewindConversation: true,
  swapRewind: true,
  restoreRewindCode: true,
  steerTurn: true,
  addAttachmentData: true,
  attachmentPreview: true,
  mentionFiles: true,
  listSlashCommands: true,
  readCustomPrompt: true,
});
