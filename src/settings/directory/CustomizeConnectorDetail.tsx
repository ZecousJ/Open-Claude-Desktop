import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowUpRight, Check, Copy, Link } from "../../ui/glyphs";
import { currentLocale, t, useLocale } from "../../i18n";
import { Button } from "../controls";
import { showToast } from "../../ui/toast-store";
import { ToolPermissions } from "../tabs/ToolPermissions";
import type { ConnectorDetailProps } from "../tabs/ConnectorDetail";
import {
  connectorCategories,
  connectorDetailPath,
  connectorPublishedUrl,
  connectorSupportUrl,
  connectorToolNames,
} from "./connector-detail-model";
import { ConnectorLogo, ConnectorRows } from "./ConnectorRows";
import { DirectoryReviewBadge } from "./DirectoryReview";
import "../tabs/connector-detail.css";
import { useHost } from "../../host/HostContext";
import { connectorShareLink } from "../../../shared/connector-links";
import { useConnectorOwner } from "../connector-owner";
import { connectorCategory } from "./connector-categories";
import { ConnectorHeaderSlot } from "../../collections/customize/connector-header-slot";

function Metadata({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="connector-published-field">
      <dt>
        <h3>{label}</h3>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The observed directory page; native Settings details retain their own shell. */
export function CustomizeConnectorDetail({
  entry,
  server,
  editable,
  onBack,
  onConnect,
  onEdit,
  onSet,
  onError,
  onOpenCategory,
  related = [],
  onOpenRelated,
  onConnectRelated,
  relatedServers,
  canConnectRelated,
  remoteIcons = true,
}: ConnectorDetailProps) {
  useLocale();
  const host = useHost();
  const headerSlot = useContext(ConnectorHeaderSlot);
  const owner = useConnectorOwner(
    JSON.stringify([entry?.id, server?.name, server?.url ?? entry?.url]),
  );
  const [pendingOwner, setPendingOwner] = useState<number>();
  const busy = pendingOwner === owner.key;
  const [expandedTools, setExpandedTools] = useState(false);
  const publishedTools = connectorToolNames(entry?.tools ?? [], expandedTools);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const scope = owner.key;
  const [copiedUrl, setCopiedUrl] = useState<{
    scope: typeof scope;
    value: string;
  }>();
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const scopeCurrent = owner.current;
  const connect = () => {
    if (!owner.current() || busy) return;
    const operation = owner.capture("connect");
    setPendingOwner(owner.key);
    void onConnect(operation)
      .catch((error) => {
        if (operation.current()) onError(error);
      })
      .finally(() => {
        if (operation.current()) setPendingOwner(undefined);
      });
  };
  const name = server?.displayName ?? server?.name ?? entry!.name;
  const url = server?.url ?? entry?.url;
  const connected =
    server?.state === "ready" && server.authStatus !== "notLoggedIn";
  const categories = connectorCategories(entry);
  const publisher = entry?.byline.startsWith("by ")
    ? entry.byline.slice(3)
    : undefined;
  const publisherUrl = connectorPublishedUrl(entry?.publisherUrl);
  const moreInfo = [
    ["Documentation", connectorPublishedUrl(entry?.documentationUrl)],
    ["Support", connectorSupportUrl(entry?.supportUrl)],
    ["Privacy Policy", connectorPublishedUrl(entry?.privacyPolicyUrl)],
  ].filter((pair): pair is [string, string] => !!pair[1]);
  const signIn =
    entry?.isAuthless !== undefined
      ? !entry.isAuthless
      : server?.authStatus && server.authStatus !== "unsupported"
        ? true
        : undefined;
  const added =
    entry?.added && Number.isFinite(Date.parse(entry.added))
      ? new Date(entry.added).toLocaleDateString(currentLocale(), {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : undefined;
  const copy = (value: string, feedback = false) => {
    if (!bridge || !scopeCurrent()) return;
    const operation = owner.capture("copy");
    void operation.bridge
      .copyText(value)
      .then(() => {
        if (!operation.current()) return;
        if (!feedback) {
          showToast(t("Link copied"));
          return;
        }
        // URL-only Check feedback lasts two seconds and is set after the
        // clipboard succeeds.
        const copied = { scope, value };
        setCopiedUrl(copied);
        clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => {
          if (owner.current())
            setCopiedUrl((current) =>
              current === copied ? undefined : current,
            );
        }, 2000);
      })
      .catch((error) => {
        if (operation.current()) onError(error);
      });
  };
  const didCopyUrl = copiedUrl?.scope === scope && copiedUrl.value === url;
  return (
    <section className="connector-published-detail">
      <div className="connector-published-nav">
        <a
          href="/customize/connectors"
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onBack();
          }}
        >
          <ArrowLeft size={16} />
          Connectors
        </a>
        {headerSlot &&
          createPortal(
            <button
              type="button"
              className="connector-published-copy"
              onClick={() => {
                const id = entry?.id ?? `installed:${server!.name}`;
                copy(
                  host.kind === "desktop"
                    ? connectorShareLink(id, location.href, true)
                    : new URL(connectorDetailPath(id), location.href).href,
                );
              }}
            >
              <Link size={16} />
              Copy link
            </button>,
            headerSlot,
          )}
      </div>
      <header className="connector-published-header">
        <div className="connector-published-identity">
          {entry && (
            <span className="connector-published-icon">
              <ConnectorLogo
                entry={entry}
                size={48}
                remoteIcons={remoteIcons}
              />
            </span>
          )}
          <div className="connector-published-title">
            <div>
              <h1 data-no-translate>{name}</h1>
              {entry && (
                <DirectoryReviewBadge review={entry.type} iconSize={24} />
              )}
            </div>
            {entry?.longDescription && (
              <p data-no-translate>{entry.description}</p>
            )}
          </div>
        </div>
        <div className="connector-published-primary">
          {server?.url && editable && onEdit && (
            <Button onClick={onEdit}>Edit</Button>
          )}
          {!connected && (
            <button
              type="button"
              className="primary"
              disabled={!editable || busy}
              onClick={connect}
            >
              {busy ? t("Connecting…") : t("Connect to Claudex")}
            </button>
          )}
        </div>
      </header>
      <div className="connector-published-columns">
        <div className="connector-published-body">
          {entry?.description && (
            <p className="connector-published-description" data-no-translate>
              {entry.longDescription ?? entry.description}
            </p>
          )}
          {server?.toolList?.length ? (
            <section className="connector-published-tools">
              <h3>Tools</h3>
              <ToolPermissions
                server={name}
                tools={server.toolList}
                editable={editable}
                onSet={onSet}
              />
            </section>
          ) : (
            !!entry?.tools?.length && (
              <section className="connector-published-tools">
                <h3>Tools</h3>
                <ul
                  className="connector-published-tool-names"
                  style={{ columnCount: publishedTools.columns }}
                >
                  {publishedTools.names.map((tool) => (
                    <li key={tool} data-no-translate>
                      <span>{tool}</span>
                    </li>
                  ))}
                </ul>
                {publishedTools.clipped && (
                  <button
                    type="button"
                    className="connector-published-show-tools"
                    onClick={() => setExpandedTools(true)}
                  >
                    {t("Show all")}
                  </button>
                )}
              </section>
            )
          )}
        </div>
        <dl className="connector-published-metadata">
          {publisher && (
            <Metadata label="Made by">
              {publisherUrl ? (
                <a href={publisherUrl} target="_blank" rel="noreferrer">
                  <span data-no-translate>{publisher}</span>
                  <ArrowUpRight size={16} />
                </a>
              ) : (
                <span data-no-translate>{publisher}</span>
              )}
            </Metadata>
          )}
          {!!categories.length && (
            <Metadata
              label={categories.length === 1 ? "Category" : "Categories"}
            >
              <div className="connector-published-categories">
                {categories.map((category) => {
                  const target = connectorCategory(category);
                  return target && onOpenCategory ? (
                    <button
                      key={category}
                      type="button"
                      onClick={() => onOpenCategory(target.id)}
                    >
                      {t(category)}
                    </button>
                  ) : (
                    <span key={category}>{t(category)}</span>
                  );
                })}
              </div>
            </Metadata>
          )}
          {signIn !== undefined && (
            <Metadata label="Sign-in">
              {signIn ? "Required" : "Not required"}
            </Metadata>
          )}
          {url && (
            <Metadata label="Connector URL">
              <div className="connector-published-url">
                <span dir="ltr" data-no-translate>
                  {url}
                </span>
                <button
                  type="button"
                  aria-label={t("Copy server URL")}
                  onClick={() => copy(url, true)}
                >
                  {didCopyUrl ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </Metadata>
          )}
          {added && <Metadata label="Added to directory">{added}</Metadata>}
          {!!moreInfo.length && (
            <Metadata label="More info">
              <div className="connector-published-info">
                {moreInfo.map(([label, href]) => (
                  <a key={label} href={href} target="_blank" rel="noreferrer">
                    {t(label)}
                    <ArrowUpRight size={16} />
                  </a>
                ))}
              </div>
            </Metadata>
          )}
        </dl>
      </div>
      {!!related.length && (
        <section className="connector-published-related">
          <h3>Related connectors</h3>
          <ConnectorRows
            entries={related}
            servers={relatedServers}
            onOpen={onOpenRelated}
            onConnect={onConnectRelated}
            canConnect={canConnectRelated}
            remoteIcons={remoteIcons}
          />
        </section>
      )}
    </section>
  );
}
