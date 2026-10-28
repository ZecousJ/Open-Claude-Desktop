import { useContext } from "react";
import { Check, MessageSquare, Square, ChevronRight } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { Spinner } from "../../ui/Spinner";
import type { Item } from "../../../shared/types";
import {
  memoryRefusalTexts,
  type MemoryEditOutcome,
} from "../../../shared/memory-api";
import { itemIsRunning } from "../../../shared/activity";
import { AppContext } from "../../app/AppContext";
import { t } from "../../i18n";
import { parsePastChats } from "../../memory/chat-results";
import { memoryEditLine } from "../../memory/memory-edit-line";
import { relativeTime } from "../../ui/RelativeTime";
import { ActivityMark } from "../TurnActivity";

export { isMemoryTool, memoryToolNamespace } from "./memory-tool-kind";

type Command = "view" | "add" | "remove" | "replace";
// Auto-memory states.
const labels: Record<Command, { running: string; done: string }> = {
  view: { running: "Reading memory", done: "Read memory" },
  add: { running: "Adding to memory", done: "Added to memory" },
  // Removing reads "Removing from memory" while it runs.
  remove: { running: "Removing from memory", done: "Updated memory" },
  replace: { running: "Updating memory", done: "Updated memory" },
};

/** The row's title for a memory_edits call in each state. */
export function memoryToolTitle(item: Item) {
  const command: Command = ["view", "add", "remove", "replace"].includes(
    item.arguments?.command,
  )
    ? item.arguments.command
    : "replace";
  if (itemIsRunning(item)) return labels[command].running;
  if (item.lifecycleStatus === "interrupted")
    return command === "view"
      ? "Stopped reading memory"
      : command === "add"
        ? "Stopped creating memory"
        : "Stopped editing memory";
  if (
    item.status === "failed" ||
    item.success === false ||
    item.lifecycleStatus === "failed"
  )
    return command === "view"
      ? "Couldn’t read memory"
      : command === "add"
        ? "Couldn’t add to memory"
        : "Couldn’t update memory";
  return labels[command].done;
}

const toolFailed = (item: Item) =>
  item.status === "failed" ||
  item.success === false ||
  item.lifecycleStatus === "failed";

const resultTexts = (item: Item) =>
  (Array.isArray(item.contentItems) ? item.contentItems : [])
    .filter(
      (value: any) =>
        value?.type === "inputText" && typeof value.text === "string",
    )
    .map((value: any) => value.text as string);

/** The tool's own text for a removed line: "Removed line 2 from memory: <statement>". */
const removedStatement = (texts: string[]) =>
  texts
    .map((text) => /^Removed line \d+ from memory: (.+)$/s.exec(text)?.[1])
    .find((name): name is string => !!name?.trim());

/** A name for a line a result mentions: one line, at most 40 characters. */
const shortName = (text: string) => {
  const letters = [...text.replace(/\s+/g, " ").trim()];
  return letters.length > 40
    ? `${letters.slice(0, 39).join("")}…`
    : letters.join("");
};

/**
 * What a finished memory_edits call shows as its result: the original's
 * line for how the change went, not the tool's text for the model. Null for
 * a view, which lists the statements instead.
 */
export function memoryToolResultLine(item: Item): string | null {
  const command = item.arguments?.command;
  if (command === "view") return null;
  const texts = resultTexts(item);
  if (toolFailed(item)) {
    if (texts.includes(memoryRefusalTexts.sensitive))
      return memoryEditLine({ kind: "rejected" });
    if (texts.includes(memoryRefusalTexts.editTooLong))
      return memoryEditLine({ kind: "too_long", limit: 500 });
    return t("Something went wrong while updating memory");
  }
  let outcome: MemoryEditOutcome;
  if (command === "add") outcome = { kind: "added" };
  else if (command === "replace") outcome = { kind: "updated" };
  else {
    const name = removedStatement(texts);
    // A transcript from before the line named its statement has no name.
    if (!name) return t("Memory updated");
    outcome = { kind: "removed", removed: [shortName(name)] };
  }
  return memoryEditLine(outcome);
}

/** The saved statements a view call listed, one per entry. */
const viewedStatements = (texts: string[]) =>
  texts.flatMap((text) =>
    [...text.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1]),
  );

/** The title of a conversation_search or recent_chats row in each state. */
export function pastChatsTitle(item: Item) {
  const search = item.tool === "conversation_search";
  if (itemIsRunning(item))
    return search ? "Searching past chats" : "Looking at recent chats";
  if (toolFailed(item)) return "Past chats couldn't be searched";
  if (item.lifecycleStatus === "interrupted")
    return "Past chats search stopped";
  return search ? "Searched past chats" : "Looked at recent chats";
}

/**
 * A search of past chats: a plain line "Searched past chats" and the query,
 * opening to the chats it found (chat icon, title, when it was last active). A
 * click opens the chat when it still exists.
 */
function PastChatsView({ item }: { item: Item }) {
  const app = useContext(AppContext);
  const running = itemIsRunning(item);
  const failed = toolFailed(item);
  const chats = parsePastChats(resultTexts(item));
  const query =
    item.tool === "conversation_search" &&
    typeof item.arguments?.query === "string"
      ? item.arguments.query.trim()
      : "";
  const open = (id: string) =>
    app?.snapshot.conversations.find((conversation) => conversation.id === id);
  if (!running && failed)
    return (
      <div
        className="activity web-search-activity failed web-search-failed"
        role="status"
      >
        <div className="web-search-summary">
          <AppIcon name="WarningCircle" size={15} />
          <span>{pastChatsTitle(item)}</span>
        </div>
      </div>
    );
  return (
    <details className="activity web-search-activity">
      <summary>
        {running ? (
          <Spinner inheritColor className="spin" size={15} />
        ) : (
          <MessageSquare size={15} />
        )}
        <span className="web-search-title">{pastChatsTitle(item)}</span>
        {query && <small className="web-search-meta">{query}</small>}
        {!running && <ChevronRight size={13} />}
      </summary>
      {!running && (
        <div className="activity-body web-search-detail">
          {chats.length ? (
            chats.map((chat) => {
              const target = open(chat.id);
              const inner = (
                <>
                  <MessageSquare size={16} style={{ flex: "none" }} />
                  <span className="web-search-result-title">{chat.title}</span>
                  {chat.updatedAt > 0 && (
                    <span className="web-search-result-host">
                      {relativeTime(chat.updatedAt)}
                    </span>
                  )}
                </>
              );
              return target && app ? (
                <a
                  key={chat.id}
                  className="web-search-result"
                  href={`claudex://conversation/${chat.id}`}
                  title={chat.title}
                  onClick={(event) => {
                    event.preventDefault();
                    app.openConversation(target);
                  }}
                >
                  {inner}
                </a>
              ) : (
                <div
                  key={chat.id}
                  className="web-search-result"
                  title="This chat is no longer available"
                  aria-disabled="true"
                >
                  {inner}
                </div>
              );
            })
          ) : (
            <div>No matching chats</div>
          )}
        </div>
      )}
    </details>
  );
}

/**
 * A memory_edits call in the transcript: one plain row like a finished tool
 * ("Added to memory"), opening onto the statement and the tool's own result
 * text, not the raw JSON. Reuses the dynamic tool row's styles, so it adds no
 * CSS.
 */
export function MemoryToolView({ item }: { item: Item }) {
  if (item.tool === "conversation_search" || item.tool === "recent_chats")
    return <PastChatsView item={item} />;
  const running = itemIsRunning(item);
  const failed =
    item.status === "failed" ||
    item.success === false ||
    item.lifecycleStatus === "failed";
  const stopped = item.lifecycleStatus === "interrupted";
  const statement =
    typeof item.arguments?.text === "string" ? item.arguments.text.trim() : "";
  const line =
    typeof item.arguments?.line === "number" ? item.arguments.line : undefined;
  const results = (Array.isArray(item.contentItems) ? item.contentItems : [])
    .filter(
      (value: any) =>
        value?.type === "inputText" && typeof value.text === "string",
    )
    .map((value: any) => value.text as string);
  const resultLine = running ? null : memoryToolResultLine(item);
  // Turned down (a sensitive or too long change) rather than broken.
  const refused =
    failed &&
    (results.includes(memoryRefusalTexts.sensitive) ||
      results.includes(memoryRefusalTexts.editTooLong));
  const viewed = viewedStatements(results);
  return (
    <details
      className={`activity dynamic-tool-activity memory-tool-activity is-plain${failed ? " failed memory-tool-warning" : ""}`}
      // A refused or failed change is announced: failures at once, the rest
      // politely.
      aria-live={failed ? (refused ? "polite" : "assertive") : undefined}
    >
      <summary>
        {running ? (
          <ActivityMark phase="tools" />
        ) : failed ? (
          <AppIcon name="WarningCircle" size={15} />
        ) : stopped ? (
          <Square size={13} />
        ) : (
          <Check size={16} />
        )}
        <span className="dynamic-tool-title">{memoryToolTitle(item)}</span>
        <ChevronRight size={13} />
      </summary>
      <div className="activity-body dynamic-tool-body">
        {(statement || line !== undefined) && (
          <section>
            <strong>{line !== undefined ? `Line ${line}` : "Statement"}</strong>
            {statement && <pre>{statement}</pre>}
          </section>
        )}
        {results.length &&
        !running &&
        (resultLine !== null || viewed.length) ? (
          <section>
            <strong>Result</strong>
            {resultLine !== null ? (
              <pre>{resultLine}</pre>
            ) : (
              viewed.map((text, index) => <pre key={index}>{text}</pre>)
            )}
          </section>
        ) : (
          <p>
            {running
              ? "Waiting for memory…"
              : item.resultOmitted
                ? "Large result omitted from this transcript"
                : "No result"}
          </p>
        )}
      </div>
    </details>
  );
}
