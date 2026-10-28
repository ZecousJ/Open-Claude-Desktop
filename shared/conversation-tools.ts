/** Scoped tool selection. The caller explicitly chooses account, project,
 * conversation or pending-draft storage; this module never infers that scope.
 * Connector/tool names come from the host's real catalog, not display names. */
export type ConversationToolOverrides = Readonly<
  Record<string, Readonly<Record<string, boolean>>>
>;

export interface ConversationToolDefinition {
  name: string;
  description?: string;
  /** Effective host/policy restriction; a conversation cannot override it. */
  blocked?: boolean;
  blockedReason?: string;
}
export interface ConversationToolCatalogEntry {
  name: string;
  displayName?: string;
  /** Explicit host readiness. No auth/connect operation is implied here. */
  available: boolean;
  unavailableReason?: string;
  /** Non-editable restrictions outside the caller's save scope. For a
   * conversation this includes global disabled_tools. A caller editing the
   * account's mutable choices represents those choices in overrides instead. */
  disabledTools: readonly string[];
  tools: readonly ConversationToolDefinition[];
}
export type ConversationToolCatalog = readonly ConversationToolCatalogEntry[];

export function conversationToolSelectable(
  connector: ConversationToolCatalogEntry,
  tool: ConversationToolDefinition,
) {
  return (
    connector.available === true &&
    tool.blocked !== true &&
    !connector.disabledTools.includes(tool.name)
  );
}
export function conversationToolEnabled(
  connector: ConversationToolCatalogEntry,
  tool: ConversationToolDefinition,
  overrides: ConversationToolOverrides,
) {
  return (
    conversationToolSelectable(connector, tool) &&
    overrides[connector.name]?.[tool.name] !== false
  );
}

/** One sparse, atomic update; a search filters the display, never this set.
 * True only removes a conversation's own false value. It cannot lift a
 * baseline disabled_tools entry or a host/policy block. */
export function conversationToolPatch(
  connector: ConversationToolCatalogEntry,
  names: readonly string[],
  enabled: boolean,
  overrides: ConversationToolOverrides,
): ConversationToolOverrides {
  const targets = new Set(names);
  const tools = Object.fromEntries(
    connector.tools
      .filter(
        (tool) =>
          targets.has(tool.name) &&
          conversationToolSelectable(connector, tool) &&
          conversationToolEnabled(connector, tool, overrides) !== enabled,
      )
      .map((tool) => [tool.name, enabled]),
  );
  return Object.keys(tools).length ? { [connector.name]: tools } : {};
}
export function mergeConversationToolOverrides(
  overrides: ConversationToolOverrides,
  patch: ConversationToolOverrides,
): ConversationToolOverrides {
  return Object.fromEntries(
    [...new Set([...Object.keys(overrides), ...Object.keys(patch)])].map(
      (name) => [name, { ...overrides[name], ...patch[name] }],
    ),
  );
}

/** Codex's real mcp_servers.<name>.disabled_tools thread override. Approval
 * settings are deliberately absent. Unknown global entries are retained. */
export function conversationDisabledTools(
  connector: ConversationToolCatalogEntry,
  overrides: ConversationToolOverrides,
): string[] {
  return [
    ...new Set([
      ...connector.disabledTools,
      ...connector.tools
        .filter(
          (tool) =>
            tool.blocked === true ||
            overrides[connector.name]?.[tool.name] === false,
        )
        .map((tool) => tool.name),
    ]),
  ];
}
