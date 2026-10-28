import { useContext, useEffect, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import type {
  BackgroundTaskSuggestion,
  TaskBacklogItem,
} from "../../shared/task-backlog";
import { formatText, useT } from "../i18n";
import { Menu, type MenuPosition } from "../ui/Menu";
import { showToast } from "../ui/toast-store";
import { CodeHomeSuggestionsSlot } from "./CodeHomeSuggestionsSlot";
import { StartCardRow, StartCardRows, startRowOrder } from "./StartCardRows";
import "./task-suggestions.css";

/**
 * Seats in the start card's list: more tasks than that fold their tail into one
 * group row.
 */
const seats = 3;

/**
 * Backlog rows put the prompt in the composer, never run it. The tasks are rows
 * of the start card's list, each with its own delete; past three they fold into
 * "N more suggested tasks" that opens a popup.
 */
export function TaskSuggestions({
  cwd,
  conversation,
  onPrompt,
  canTake = true,
  onError,
}: {
  cwd?: string;
  conversation?: Conversation;
  canTake?: boolean;
  onPrompt(prompt: string): void;
  /** Optional: the composer leaves it out, as the list is an extra and a failed load only logs. */
  onError?(error: unknown): void;
}) {
  const t = useT();
  const folder = conversation?.cwd ?? cwd;
  const [backlog, setBacklog] = useState<TaskBacklogItem[]>([]);
  const slot = useContext(CodeHomeSuggestionsSlot);
  const [group, setGroup] = useState<{
    position: MenuPosition;
    width: number;
  }>();
  const groupAnchor = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setBacklog([]);
    const failed = (error: unknown) => {
      if (!current) return;
      console.error("Could not load task backlog", error);
      onError?.(error);
    };
    // The backlog is filed on this computer: a remote session's folder has none.
    if (
      folder &&
      !conversation?.incognito &&
      (conversation?.environment?.kind ?? "local") === "local"
    )
      void Promise.resolve()
        .then(() => window.desktop.getTaskBacklog(folder, 20))
        .then((items) => {
          if (!current) return;
          if (
            !Array.isArray(items) ||
            items.some(
              (item) =>
                !item ||
                typeof item.id !== "string" ||
                typeof item.title !== "string" ||
                typeof item.prompt !== "string" ||
                (item.tldr !== undefined && typeof item.tldr !== "string"),
            )
          ) {
            console.error("getTaskBacklog returned an invalid response");
            failed(new Error(t("Something went wrong. Try again.")));
            return;
          }
          setBacklog(items);
        }, failed);
    return () => {
      current = false;
    };
  }, [folder, conversation?.id, conversation?.incognito, attempt]);
  const pending = conversation?.backgroundTaskSuggestions ?? [];
  if ((!backlog.length && !pending.length) || conversation?.incognito)
    return null;
  const resolve = async (list: Item[], taken: boolean) => {
    if (busy || (taken && !canTake)) return;
    setBusy(list[0].id);
    const removed = new Set<string>();
    try {
      for (const item of list) {
        const done =
          item.pending && conversation
            ? await window.desktop.popBackgroundTaskSuggestionById(
                conversation.id,
                item.id,
                taken,
              )
            : await window.desktop.dismissTaskBacklogItem(item.id, taken);
        if (done) removed.add(item.id);
      }
      if (taken && removed.size) {
        onPrompt(list[0].prompt);
        setGroup(undefined);
      }
    } catch {
      showToast(
        t(
          taken
            ? "Couldn’t take this task off the list. It will show up again."
            : "Couldn’t delete this task. Try again.",
        ),
      );
    } finally {
      if (removed.size) {
        setBacklog((items) => items.filter((item) => !removed.has(item.id)));
        if (list.some((item) => item.pending && removed.has(item.id)))
          setAttempt((value) => value + 1);
      }
      setBusy(undefined);
    }
  };
  const items: Item[] = [
    ...pending.map((entry) => ({ ...entry, pending: true })),
    ...backlog.map((entry) => ({ ...entry, pending: false })),
  ];
  const rows = items.length <= seats ? items : items.slice(0, seats - 1);
  const rest = items.slice(rows.length);
  const title = (item: Item) => item.title;
  const deleteLabel = (item: Item) =>
    formatText("Delete “{title}”", { title: title(item) });
  return (
    <StartCardRows slot={slot}>
      {rows.map((item) => (
        <StartCardRow
          key={item.id}
          className="task-suggestion-row"
          order={startRowOrder.suggestedTasks}
          title={title(item)}
          tooltip={[item.title, item.tldr].filter(Boolean).join(" ")}
          label={formatText("Put “{title}” in the message box", {
            title: title(item),
          })}
          end="spacer"
          dismissLabel={deleteLabel(item)}
          onPress={() => void resolve([item], true)}
          onDismiss={() => void resolve([item], false)}
        />
      ))}
      {rest.length > 0 && (
        <StartCardRow
          key="rest"
          className="task-suggestion-row task-suggestion-group"
          order={startRowOrder.suggestedTasks}
          title={restTitle(rest.length, rows.length === 0)}
          end="caret"
          dismissLabel={formatText(
            rest.length === 1
              ? "Delete 1 suggested task"
              : "Delete {count} suggested tasks",
            { count: rest.length },
          )}
          onPress={(event) => {
            const button = event.currentTarget;
            groupAnchor.current = button;
            const box = button.getBoundingClientRect();
            setGroup((open) =>
              open
                ? undefined
                : {
                    position: { left: box.left, top: box.bottom + 4 },
                    width: box.width,
                  },
            );
          }}
          onDismiss={() => void resolve(rest, false)}
        />
      )}
      {group && rest.length > 0 && (
        <Menu
          label={restTitle(rest.length, rows.length === 0)}
          position={group.position}
          width={group.width}
          anchors={[groupAnchor]}
          onClose={() => setGroup(undefined)}
          entries={rest.map((item) => ({
            label: title(item),
            noTranslate: true,
            title: item.tldr,
            disabled: !!busy,
            onSelect: () => void resolve([item], true),
            trailing: {
              text: t("Delete"),
              label: deleteLabel(item),
              danger: true,
              onAction: () => void resolve([item], false),
            },
          }))}
        />
      )}
    </StartCardRows>
  );

  function restTitle(count: number, whole: boolean) {
    return formatText(
      whole
        ? count === 1
          ? "1 suggested task"
          : "{count} suggested tasks"
        : count === 1
          ? "1 more suggested task"
          : "{count} more suggested tasks",
      { count },
    );
  }
}

type Item = (TaskBacklogItem | BackgroundTaskSuggestion) & {
  pending: boolean;
};
