import { useLayoutEffect, useRef, useState } from "react";
import {
  conversationToolEnabled,
  conversationToolPatch,
  conversationToolSelectable,
  mergeConversationToolOverrides,
  type ConversationToolCatalog,
  type ConversationToolCatalogEntry,
  type ConversationToolDefinition,
  type ConversationToolOverrides,
} from "../../shared/conversation-tools";
import { Modal } from "../ui/Controls";
import { Blocks, ChevronRight, Search } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import { formatText, t, useLocale } from "../i18n";
import "./conversation-tool-picker.css";

type Action = { server: string; tools: readonly string[]; enabled: boolean };
export interface ConversationToolPickerProps {
  catalog: ConversationToolCatalog;
  overrides: ConversationToolOverrides;
  /** Stable identity of the account, bridge and caller's actual save scope
   * (account/project/conversation/new draft). This leaf never chooses scope. */
  owner: object;
  /** Also checks retirement which can happen without another React render. */
  current: () => boolean;
  /** One acknowledged atomic merge in that declared scope. No auth or
   * approval-mode mutation is implied by this availability-only patch. */
  onSave: (patch: ConversationToolOverrides) => Promise<void>;
  onClose: () => void;
}

/**
 * O16: connector selection followed by Customize <server>, tool search,
 * per-tool switches and any-enabled bulk Enable/Disable all. Authentication is
 * owned by the caller's actual host.
 */
export function ConversationToolPicker(props: ConversationToolPickerProps) {
  useLocale();
  const { catalog, overrides, owner } = props;
  const live = useRef(props);
  live.current = props;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const closed = useRef<object | undefined>(undefined);
  const [closedOwner, setClosedOwner] = useState<object>();
  const valid = () =>
    mounted.current &&
    live.current.owner === owner &&
    closed.current !== owner &&
    live.current.current();
  const [view, setView] = useState<{
    owner: object;
    server?: string;
    search: string;
  }>({ owner, search: "" });
  const shown: { owner: object; server?: string; search: string } =
    view.owner === owner ? view : { owner, search: "" };
  const selected = catalog.find((server) => server.name === shown.server);
  const [saved, setSaved] = useState<{
    owner: object;
    input: ConversationToolOverrides;
    value: ConversationToolOverrides;
  }>();
  const value =
    saved?.owner === owner && saved.input === overrides
      ? saved.value
      : overrides;
  const pending = useRef<{ owner: object } | undefined>(undefined);
  const [pendingOwner, setPendingOwner] = useState<object>();
  const busy = pendingOwner === owner;
  const [failure, setFailure] = useState<{ owner: object; action: Action }>();

  function close() {
    if (!valid()) return;
    closed.current = owner;
    setClosedOwner(owner);
    props.onClose();
  }
  async function save(action: Action) {
    if (!valid() || pending.current?.owner === owner) return;
    const connector = live.current.catalog.find(
      (server) => server.name === action.server,
    );
    if (!connector) return;
    const input = live.current.overrides;
    const base =
      saved?.owner === owner && saved.input === input ? saved.value : input;
    const patch = conversationToolPatch(
      connector,
      action.tools,
      action.enabled,
      base,
    );
    if (!Object.keys(patch).length) {
      setFailure(undefined);
      return;
    }
    const request = { owner };
    pending.current = request;
    setPendingOwner(owner);
    setFailure(undefined);
    try {
      await props.onSave(patch);
      if (!valid() || pending.current !== request) return;
      if (live.current.overrides === input)
        setSaved({
          owner,
          input,
          value: mergeConversationToolOverrides(base, patch),
        });
    } catch {
      if (valid() && pending.current === request) setFailure({ owner, action });
    } finally {
      if (pending.current === request) {
        pending.current = undefined;
        if (valid()) setPendingOwner(undefined);
      }
    }
  }
  const reason = (
    server: ConversationToolCatalogEntry,
    tool?: ConversationToolDefinition,
  ) =>
    !server.available
      ? server.unavailableReason || t("This connector isn’t available.")
      : tool?.blocked
        ? tool.blockedReason || t("This tool isn’t available.")
        : tool && server.disabledTools.includes(tool.name)
          ? tool.blockedReason || t("Disabled in connector settings")
          : undefined;
  function toggle(server: ConversationToolCatalogEntry, tools = server.tools) {
    if (!valid()) return;
    const any = tools.some((tool) =>
      conversationToolEnabled(server, tool, value),
    );
    void save({
      server: server.name,
      tools: tools.map((tool) => tool.name),
      enabled: !any,
    });
  }
  function switchMark(enabled: boolean) {
    return (
      <span
        className="conversation-tool-switch"
        data-enabled={enabled}
        aria-hidden="true"
      />
    );
  }
  if (closedOwner === owner || !props.current()) return null;
  return (
    <Modal
      title={
        selected
          ? formatText("Customize {serverName}", {
              serverName: selected.displayName || selected.name,
            })
          : t("Allow access to connectors and tools")
      }
      titleIsUserData={Boolean(selected)}
      className="conversation-tool-picker"
      showClose={false}
      onClose={close}
      back={
        selected
          ? {
              label: t("Back"),
              onClick: () => {
                if (valid()) setView({ owner, search: "" });
              },
            }
          : undefined
      }
    >
      <div className="conversation-tool-picker-body" aria-busy={busy}>
        {!selected ? (
          <>
            <p className="conversation-tool-section-title">{t("Connectors")}</p>
            {!catalog.length && (
              <p className="conversation-tool-empty">{t("No connectors")}</p>
            )}
            <ul className="conversation-tool-list">
              {catalog.map((server) => {
                const count = server.tools.filter((tool) =>
                  conversationToolEnabled(server, tool, value),
                ).length;
                const selectable = server.tools.some((tool) =>
                  conversationToolSelectable(server, tool),
                );
                const name = server.displayName || server.name;
                return (
                  <li className="conversation-tool-connector" key={server.name}>
                    <div
                      className="conversation-tool-connector-row"
                      role="button"
                      tabIndex={server.available ? 0 : -1}
                      aria-disabled={!server.available}
                      aria-label={formatText("Customize {serverName}", {
                        serverName: name,
                      })}
                      onClick={() => {
                        if (valid() && server.available)
                          setView({ owner, server: server.name, search: "" });
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.target === event.currentTarget &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          if (valid() && server.available)
                            setView({ owner, server: server.name, search: "" });
                        }
                      }}
                    >
                      <Blocks size={20} />
                      <span
                        className="conversation-tool-name"
                        data-no-translate
                      >
                        {name}
                      </span>
                      <span className="conversation-tool-connector-actions">
                        {!server.tools.length ? (
                          t("Disabled")
                        ) : count === 0 || count === server.tools.length ? (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={count === server.tools.length}
                            aria-label={name}
                            disabled={busy || !selectable}
                            title={reason(server)}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggle(server);
                            }}
                          >
                            {switchMark(count === server.tools.length)}
                          </button>
                        ) : (
                          <span
                            className="conversation-tool-count"
                            data-no-translate
                          >
                            {formatText("{count} of {total}", {
                              count,
                              total: server.tools.length,
                            })}
                          </span>
                        )}
                        <ChevronRight size={16} />
                      </span>
                    </div>
                    {!server.available && (
                      <small data-no-translate>{reason(server)}</small>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <label className="conversation-tool-search">
              <Search size={16} />
              <input
                type="search"
                aria-label={t("Search tools")}
                placeholder={t("Search tools")}
                value={shown.search}
                onChange={(event) => {
                  if (valid())
                    setView({
                      owner,
                      server: selected.name,
                      search: event.target.value,
                    });
                }}
              />
            </label>
            <div className="conversation-tool-options">
              {selected.tools.length > 1 && (
                <button
                  type="button"
                  className="conversation-tool-all"
                  role="switch"
                  aria-checked={selected.tools.some((tool) =>
                    conversationToolEnabled(selected, tool, value),
                  )}
                  disabled={
                    busy ||
                    !selected.tools.some((tool) =>
                      conversationToolSelectable(selected, tool),
                    )
                  }
                  onClick={() => toggle(selected)}
                >
                  <span>
                    {t(
                      selected.tools.some((tool) =>
                        conversationToolEnabled(selected, tool, value),
                      )
                        ? "Disable all tools"
                        : "Enable all tools",
                    )}
                  </span>
                  {switchMark(
                    selected.tools.some((tool) =>
                      conversationToolEnabled(selected, tool, value),
                    ),
                  )}
                </button>
              )}
              {selected.tools
                .filter((tool) =>
                  tool.name.toLowerCase().includes(shown.search.toLowerCase()),
                )
                .map((tool) => {
                  const blocked = reason(selected, tool);
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      className="conversation-tool-option"
                      role="switch"
                      aria-label={tool.name}
                      aria-checked={conversationToolEnabled(
                        selected,
                        tool,
                        value,
                      )}
                      disabled={
                        busy || !conversationToolSelectable(selected, tool)
                      }
                      title={blocked}
                      onClick={() => toggle(selected, [tool])}
                    >
                      <span>
                        <strong data-no-translate>{tool.name}</strong>
                        {tool.description && (
                          <small data-no-translate>{tool.description}</small>
                        )}
                        {blocked && <small data-no-translate>{blocked}</small>}
                      </span>
                      {switchMark(
                        conversationToolEnabled(selected, tool, value),
                      )}
                    </button>
                  );
                })}
              {!selected.tools.some((tool) =>
                tool.name.toLowerCase().includes(shown.search.toLowerCase()),
              ) && (
                <p className="conversation-tool-empty" data-no-translate>
                  {formatText("No tools matching “{search}”", {
                    search: shown.search,
                  })}
                </p>
              )}
            </div>
          </>
        )}
        {busy && (
          <span className="conversation-tool-saving" role="status">
            <Spinner size={16} />
            {t("Saving…")}
          </span>
        )}
        {failure?.owner === owner && (
          <p className="conversation-tool-failure" role="alert">
            {t("Couldn’t save your change. Try again.")}{" "}
            <button type="button" onClick={() => void save(failure.action)}>
              {t("Try again")}
            </button>
          </p>
        )}
      </div>
      {!selected && (
        <footer>
          <button type="button" onClick={close}>
            {t("Continue")}
          </button>
        </footer>
      )}
    </Modal>
  );
}
