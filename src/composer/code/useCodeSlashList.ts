import { useEffect, useMemo, useState } from "react";
import type { SlashCommandList } from "../../../shared/composer-api";
import type { Conversation } from "../../../shared/types";
import {
  availableCodeSlashCommands,
  codeSlashCommands,
  filterCodeSlashCommands,
} from "./code-slash-commands";

/**
 * The Code composer's / palette: what the line typed so far asks for, the
 * commands that match it, and a chosen command's argument hint.
 */
export function useCodeSlashList({
  query,
  pending,
  active,
  cwd,
  running,
  planAllowed,
}: {
  /** The text after / while a bare command is typed; null otherwise. */
  query: string | null;
  /** The chosen command waiting for its argument. */
  pending: string | null;
  active?: Conversation;
  cwd?: string;
  running: boolean;
  planAllowed: boolean;
}) {
  const [list, setList] = useState<SlashCommandList | null>(null);
  const typing = query !== null;
  const folder = active ? undefined : cwd;
  useEffect(() => {
    if (!typing) return;
    let current = true;
    window.desktop
      .listSlashCommands(active ? { conversationId: active.id } : { folder })
      .then(
        (value) => current && setList(value),
        () => current && setList(null),
      );
    return () => {
      current = false;
    };
  }, [typing, active?.id, folder]);
  const custom = (name: string) =>
    codeSlashCommands.some((command) => command.name === name)
      ? undefined
      : list?.commands.find((command) => command.name === name);
  // The argument hint the command declares (the original's argumentHint).
  const placeholder = pending
    ? pending === "review"
      ? "[base <branch> | commit <sha> | instructions]"
      : (codeSlashCommands.find((command) => command.name === pending)
          ?.argumentHint ??
        custom(pending)?.argumentHint ??
        "")
    : "";
  const commands = useMemo(
    () =>
      query !== null
        ? filterCodeSlashCommands(
            query,
            availableCodeSlashCommands({
              conversationIdle: Boolean(active) && !running,
              hasSession: Boolean(active),
              planAllowed,
              usageCredits: list?.usageCredits,
              custom: list?.commands,
            }),
          )
        : [],
    [query, planAllowed, active, running, list],
  );
  return { commands, placeholder, custom };
}
