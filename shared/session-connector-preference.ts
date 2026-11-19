import type { Conversation } from "./types";

/** Only session choices, never connector definitions or account permissions. */
export interface SessionConnectorPreference {
  connectorOverrides: Record<string, boolean>;
  connectorToolOverrides: Record<string, Record<string, boolean>>;
}

/** Stable semantic snapshot, independent of object insertion order. */
export function sessionConnectorPreferenceSnapshot(
  value: Pick<Conversation, "connectorOverrides" | "connectorToolOverrides">,
): string {
  const entries = (record: Record<string, boolean> | undefined) =>
    Object.entries(record ?? {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
  return JSON.stringify([
    entries(value.connectorOverrides),
    Object.entries(value.connectorToolOverrides ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([server, tools]) => [server, entries(tools)]),
  ]);
}
