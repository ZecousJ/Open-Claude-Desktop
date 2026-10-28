import { useEffect, useState } from "react";
import type { KnowledgeMcpResource } from "../../../shared/collections-api";
import { t } from "../../i18n";
import { SettingsModal } from "../../settings/controls";
import { Spinner } from "../../ui/Spinner";
import "./knowledge-mcp.css";

const looksLikeUrl = (value: string) => /^[a-z][\w+.-]*:\/\/\S+$/i.test(value);

/**
 * A connected MCP server's resources for the project's knowledge: "Search
 * resources or paste URL"; a pasted URL is resolved through the server; picking
 * one adds it as a synced file.
 */
export function KnowledgeMcpDialog({
  projectId,
  server,
  onClose,
  onAdd,
}: {
  projectId: string;
  server: string;
  onClose: () => void;
  onAdd: (resource: KnowledgeMcpResource) => void;
}) {
  const [query, setQuery] = useState("");
  const [resources, setResources] = useState<KnowledgeMcpResource[]>();
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void window.desktop
      .listProjectKnowledgeMcpResources(projectId, server)
      .then((list) => live && setResources(list))
      .catch(() => live && setResources([]));
    return () => {
      live = false;
    };
  }, [projectId, server]);
  const words = query.trim().toLowerCase();
  const shown = (resources ?? []).filter(
    (resource) =>
      !words ||
      [resource.name, resource.title, resource.description, resource.uri]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(words)),
  );
  const resolve = async (url: string) => {
    if (!looksLikeUrl(url)) {
      setError(t("Unable to resolve URL through MCP server"));
      return;
    }
    setResolving(true);
    setError("");
    try {
      onAdd(
        await window.desktop.resolveProjectKnowledgeMcpUrl(
          projectId,
          server,
          url,
        ),
      );
    } catch {
      setError(
        t("Failed to resolve URL. Make sure the MCP server supports this URL."),
      );
    } finally {
      setResolving(false);
    }
  };
  return (
    <SettingsModal title={server} onClose={onClose} className="knowledge-mcp">
      <input
        className="knowledge-mcp-search"
        autoFocus
        aria-label={t("Search resources or paste URL")}
        placeholder={t("Search resources or paste URL")}
        value={query}
        disabled={resolving}
        onChange={(event) => {
          setQuery(event.target.value);
          setError("");
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text").trim();
          if (looksLikeUrl(text)) {
            event.preventDefault();
            setQuery(text);
            void resolve(text);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && looksLikeUrl(query.trim())) {
            event.preventDefault();
            void resolve(query.trim());
          }
        }}
      />
      {error && (
        <p className="knowledge-mcp-error" role="alert">
          {error}
        </p>
      )}
      {resources === undefined || resolving ? (
        <div className="knowledge-mcp-loading" role="status">
          <Spinner size="md" />
        </div>
      ) : shown.length ? (
        <ul className="knowledge-mcp-list" aria-label={server}>
          {shown.map((resource) => (
            <li key={resource.uri}>
              <button type="button" onClick={() => onAdd(resource)}>
                <span data-no-translate className="knowledge-mcp-name">
                  {resource.title || resource.name}
                </span>
                {resource.description && (
                  <span data-no-translate className="knowledge-mcp-detail">
                    {resource.description}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !looksLikeUrl(query.trim()) && (
          <p className="knowledge-mcp-empty">{t("No resources found")}</p>
        )
      )}
    </SettingsModal>
  );
}
