import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, EllipsisVertical, Check, ChevronDown } from "../../ui/glyphs";
import { surface } from "../../../shared/host";
import { api } from "../../desktop-api";
import {
  maskedKey,
  rateText,
  type ApiGroup,
  type ApiGroups,
  type ApiKey,
  type ApiProvider,
} from "../../../shared/api-keys-api";
import { useApp } from "../../app/AppContext";
import { InfoIcon } from "../../ui/icons";
import { Menu, type MenuEntry } from "../../ui/Menu";
import { collectionTime } from "../collection-time";
import { t, tf, useT } from "../../i18n";
import { cost } from "../../settings/usage-activity/format";
import { NewKeyDialog } from "./NewKeyDialog";
import { ProviderLogo } from "./ProviderLogo";
import "../routines/scheduled.css";
import "./api.css";
import { CardsSkeleton } from "../../ui/Skeleton";

type OpenMenu =
  | { kind: "group"; rect: DOMRect; provider: ApiProvider }
  | { kind: "models"; rect: DOMRect; provider: ApiProvider; group: ApiGroup }
  | { kind: "key"; rect: DOMRect; key: ApiKey }
  | { kind: "image"; rect: DOMRect };

/** Each menu's width. */
const menuWidths = { group: 200, models: 260, key: 168, image: 200 } as const;

/**
 * Image generation as a provider card: OpenAI's mark, the drawing group's
 * models, and the one every picture is made with where the others show their
 * group.
 */
function imagesCard(images: NonNullable<ApiGroups["images"]>): ApiProvider {
  const chosen = images.models.find((model) => model.id === images.selected);
  return {
    id: "images",
    name: t("Image generation"),
    groups: [
      {
        id: images.groupId,
        name: chosen?.name ?? images.selected,
        models: images.models.length,
        modelList: images.models,
        primary: false,
        protocol: "responses",
        platform: "openai",
      },
    ],
    selected: images.groupId,
  };
}

/** A key's state in words, when it is not simply in use. */
const stateWords: Partial<Record<ApiKey["status"], string>> = {
  inactive: "Disabled",
  expired: "Expired",
  exhausted: "Quota used up",
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The API page, in two parts. Models: one card per provider (OpenAI, xAI,
 * Anthropic, …, also those without a group yet) with a menu of the groups the
 * account may use for it, which the model menus follow. API keys: the
 * account's own keys. Laid out as the web's Scheduled tasks page: the title
 * and its note over cards with a 36px tile, a name, a line of text and a
 * menu; a part's title is a history page's group heading.
 */
export function ApiPage() {
  const app = useApp();
  const [groups, setGroups] = useState<ApiGroups>();
  const [rates, setRates] = useState<Record<number, number>>({});
  const [keys, setKeys] = useState<ApiKey[]>();
  const [failure, setFailure] = useState("");
  // The groups never loaded: the page says so with Retry, not that the
  // account is signed out (as the original's Couldn’t load routines).
  const [groupsFailed, setGroupsFailed] = useState(false);
  const shownGroups = useRef(groups);
  shownGroups.current = groups;
  const [menu, setMenu] = useState<OpenMenu>();
  const [creating, setCreating] = useState(false);
  const groupAnchor = useRef<HTMLElement | null>(null);
  const rowAnchor = useRef<HTMLElement | null>(null);
  const { report, notify } = app;

  const load = useCallback(async () => {
    setFailure("");
    // Each part shows as it arrives: the groups as last read at once, then
    // as the service lists them now (a group added since gets its key).
    const keys = api.apiKeys().then(setKeys, (error: unknown) => {
      setFailure(error instanceof Error ? error.message : String(error));
      setKeys([]);
    });
    // The rates are a courtesy: without them the page shows none.
    const rates = Promise.resolve()
      .then(() => api.groupRates())
      .then(
        (next) => setRates(next ?? {}),
        () => {},
      );
    setGroupsFailed(false);
    try {
      setGroups(await api.apiGroups());
      setGroups(await api.apiGroups(true));
    } catch (error) {
      if (shownGroups.current) report(error);
      else {
        console.error("The API groups did not load:", error);
        setGroupsFailed(true);
      }
      setGroups((current) => current ?? { groups: [], providers: [] });
    }
    await Promise.all([keys, rates]);
  }, [report]);
  useEffect(() => void load(), [load]);

  /** Uses a group's models for its provider; the composer's model follows when it left the list. */
  async function useGroup(providerId: string, id: number) {
    try {
      setGroups(await api.setApiGroup(providerId, id));
      const catalog = await api.modelCatalog();
      if (catalog && !catalog.items.some((item) => item.id === app.model)) {
        const next =
          catalog.defaultModel ??
          catalog.items.find((item) => !item.hidden)?.id ??
          catalog.items[0]?.id;
        if (next) app.setModel(next);
      }
    } catch (error) {
      report(error);
    }
  }

  /** Every picture is made with this image model from now on. */
  async function useImageModel(model: string) {
    try {
      setGroups(await api.setImageModel(model));
    } catch (error) {
      report(error);
    }
  }

  async function copy(key: ApiKey) {
    try {
      await api.copyText(key.key);
      notify("API key copied");
    } catch (error) {
      report(error);
    }
  }

  function remove(key: ApiKey) {
    app.setConfirm({
      title: `Delete ${key.name}?`,
      body: "Anything that uses this key stops working at once. This can't be undone.",
      action: async () => {
        await api.deleteApiKey(key.id);
        setKeys((list) => list?.filter((item) => item.id !== key.id));
      },
    });
  }

  const menuEntries = (open: OpenMenu): MenuEntry[] =>
    open.kind === "models"
      ? (open.group.modelList ?? []).length
        ? [
            { heading: t("Click a model to copy its ID") },
            ...(open.group.modelList ?? []).map((model) => ({
              label: model.name,
              title: model.id,
              ...(model.name !== model.id ? { value: model.id } : {}),
              onSelect: () => void api.copyText(model.id),
            })),
          ]
        : [{ label: t("No models"), disabled: true }]
      : open.kind === "image"
        ? (groups?.images?.models ?? []).map((model) => ({
            label: model.name,
            title: model.id,
            checked: model.id === groups?.images?.selected,
            onSelect: () => void useImageModel(model.id),
          }))
        : open.kind === "group"
          ? open.provider.groups.map((group) => ({
              label: group.name,
              title: plural(group.models, "model"),
              ...(rates[group.id] !== undefined
                ? { badge: rateText(rates[group.id]!) }
                : {}),
              checked: group.id === open.provider.selected,
              onSelect: () => void useGroup(open.provider.id, group.id),
            }))
          : [
              { label: "Copy key", onSelect: () => void copy(open.key) },
              { separator: true },
              {
                label: "Delete key",
                danger: true,
                onSelect: () => remove(open.key),
              },
            ];

  const loading = !groups || !keys;
  const signedOut = !loading && !groups.groups.length;

  return (
    <div className="routines-view api-view">
      <div className="routines-inner">
        <div className="routines-head">
          <div>
            <h1 className="routines-title">API</h1>
            <p className="routines-subtitle">
              Switching a model group changes the models and prices available in
              Claudex chat, cowork and code. It doesn’t change API key groups.
            </p>
          </div>
        </div>
        {failure && (
          <p className="routines-notice failed" role="alert">
            <InfoIcon size={12} />
            {failure}
          </p>
        )}
        {loading ? (
          <CardsSkeleton count={4} />
        ) : groupsFailed && !groups.groups.length ? (
          <p className="routines-notice routines-load-error" role="alert">
            <InfoIcon size={12} />
            <span>Couldn’t load API keys and groups</span>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </p>
        ) : signedOut ? (
          <p className="routines-none">
            API keys and groups belong to a Claudex account. Sign in to use
            them.
          </p>
        ) : (
          <>
            <section aria-labelledby="api-models">
              <div className="api-section-head">
                <h2 id="api-models">Models</h2>
              </div>
              <ul className="routine-grid" aria-label="Providers">
                {groups.providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    rates={rates}
                    menuOpen={
                      menu?.kind === "group" && menu.provider.id === provider.id
                    }
                    modelsOpen={
                      menu?.kind === "models" &&
                      menu.provider.id === provider.id
                    }
                    onModels={(button, group) => {
                      groupAnchor.current = button;
                      setMenu({
                        kind: "models",
                        rect: button.getBoundingClientRect(),
                        provider,
                        group,
                      });
                    }}
                    onMenu={(button) => {
                      groupAnchor.current = button;
                      setMenu({
                        kind: "group",
                        rect: button.getBoundingClientRect(),
                        provider,
                      });
                    }}
                  />
                ))}
                {groups.images && (
                  <ProviderCard
                    key="images"
                    logo="openai"
                    provider={imagesCard(groups.images)}
                    rates={rates}
                    menuOpen={menu?.kind === "image"}
                    modelsOpen={
                      menu?.kind === "models" && menu.provider.id === "images"
                    }
                    onModels={(button, group) => {
                      groupAnchor.current = button;
                      setMenu({
                        kind: "models",
                        rect: button.getBoundingClientRect(),
                        provider: imagesCard(groups.images!),
                        group,
                      });
                    }}
                    onMenu={(button) => {
                      groupAnchor.current = button;
                      setMenu({
                        kind: "image",
                        rect: button.getBoundingClientRect(),
                      });
                    }}
                  />
                )}
              </ul>
            </section>
            <section aria-labelledby="api-keys">
              <div className="api-section-head">
                <h2 id="api-keys">API keys</h2>
                <div className="routines-tools">
                  <button
                    type="button"
                    className="routines-new u-press"
                    onClick={() => setCreating(true)}
                  >
                    New key
                  </button>
                </div>
              </div>
              {keys.length ? (
                <div
                  className="api-key-table"
                  role="table"
                  aria-label="Your API keys"
                >
                  <div className="api-key-row api-key-header" role="row">
                    <span role="columnheader">Key</span>
                    <span role="columnheader">Group</span>
                    <span role="columnheader">Rate</span>
                    <span role="columnheader" className="api-key-when">
                      Created
                    </span>
                    <span role="columnheader" className="api-key-when">
                      Last used
                    </span>
                    <span role="columnheader" className="api-key-cost">
                      Total cost
                    </span>
                    <span role="columnheader" aria-label="Actions" />
                  </div>
                  {keys.map((key) => (
                    <KeyRow
                      key={key.id}
                      item={key}
                      rates={rates}
                      menuOpen={menu?.kind === "key" && menu.key.id === key.id}
                      onCopy={() => void copy(key)}
                      onMenu={(button) => {
                        rowAnchor.current = button;
                        setMenu({
                          kind: "key",
                          rect: button.getBoundingClientRect(),
                          key,
                        });
                      }}
                    />
                  ))}
                </div>
              ) : (
                <p className="routines-none">No API keys yet.</p>
              )}
              <RequestUrl origin={groups.origin} />
            </section>
          </>
        )}
      </div>
      {menu && (
        <Menu
          label={
            menu.kind === "group"
              ? `${menu.provider.name} group`
              : menu.kind === "models"
                ? `${menu.provider.name} models`
                : menu.kind === "image"
                  ? "Image generation model"
                  : `${menu.key.name} actions`
          }
          width={menuWidths[menu.kind]}
          position={{
            top: menu.rect.bottom + 4,
            left: Math.max(
              8,
              menu.kind === "models"
                ? menu.rect.left
                : menu.rect.right - menuWidths[menu.kind],
            ),
          }}
          anchors={[menu.kind === "key" ? rowAnchor : groupAnchor]}
          entries={menuEntries(menu)}
          onClose={() => setMenu(undefined)}
        />
      )}
      {creating && groups && (
        <NewKeyDialog
          groups={groups}
          rates={rates}
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setKeys((list) => [key, ...(list ?? [])]);
            setCreating(false);
            void copy(key);
          }}
        />
      )}
    </div>
  );
}

/** A group's rate multiplier as Sub2API marks it: a small badge. */
function RateBadge({ rate }: { rate: number | undefined }) {
  return rate === undefined ? null : (
    <span className="rate-badge" title={tf("Rate {x}", { x: rateText(rate) })}>
      {rateText(rate)}
    </span>
  );
}

function ProviderCard({
  provider,
  logo,
  rates,
  menuOpen,
  modelsOpen,
  onMenu,
  onModels,
}: {
  provider: ApiProvider;
  /** The mark it shows when not its provider's own. */
  logo?: string;
  rates: Record<number, number>;
  menuOpen: boolean;
  modelsOpen: boolean;
  onMenu: (button: HTMLButtonElement) => void;
  onModels: (button: HTMLButtonElement, group: ApiGroup) => void;
}) {
  const chosen = provider.groups.find(
    (group) => group.id === provider.selected,
  );
  return (
    <li className={`routine-item ${chosen ? "" : "is-paused"}`}>
      <div className="routine-card api-provider">
        <span className="routine-tile" aria-hidden="true">
          <ProviderLogo id={logo ?? provider.id} />
        </span>
        <span className="routine-card-text">
          <span className="routine-card-name">
            <strong>{provider.name}</strong>
          </span>
          {chosen ? (
            <button
              type="button"
              className={`api-models-toggle ${modelsOpen ? "menu-open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={modelsOpen}
              onClick={(event) => onModels(event.currentTarget, chosen)}
            >
              {plural(chosen.models, "model")}
              <ChevronDown size={14} strokeWidth={1.6} />
            </button>
          ) : (
            <span className="routine-card-description">No groups yet</span>
          )}
        </span>
        <button
          type="button"
          className={`routines-sort api-group-select ${menuOpen ? "menu-open" : ""}`}
          aria-label={`${provider.name} group`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={!chosen}
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <b>{chosen ? chosen.name : "None"}</b>
          {chosen && <RateBadge rate={rates[chosen.id]} />}
          <ChevronDown size={16} strokeWidth={1.6} />
        </button>
      </div>
    </li>
  );
}

/** One key as a row of the keys list. Clicking the key copies it. */
function KeyRow({
  item,
  rates,
  menuOpen,
  onCopy,
  onMenu,
}: {
  item: ApiKey;
  rates: Record<number, number>;
  menuOpen: boolean;
  onCopy: () => void;
  onMenu: (button: HTMLButtonElement) => void;
}) {
  useT();
  const state = stateWords[item.status];
  return (
    <div
      role="row"
      className={`api-key-row ${item.status === "active" ? "" : "is-paused"} ${menuOpen ? "menu-open" : ""}`}
    >
      <span role="cell" className="api-key-cell-key">
        <button type="button" title={t("Copy key")} onClick={onCopy}>
          <strong>{item.name}</strong>
          {state && <span className="routine-state failed">{state}</span>}
          <span className="api-key-value">{maskedKey(item.key)}</span>
        </button>
      </span>
      <span role="cell" className="api-key-group">
        {item.groupName || "—"}
      </span>
      <span role="cell" className="api-key-rate">
        {item.groupId !== null && rates[item.groupId] !== undefined ? (
          <RateBadge rate={rates[item.groupId]} />
        ) : (
          "—"
        )}
      </span>
      <span role="cell" className="api-key-when">
        {item.createdAt ? collectionTime(item.createdAt) : "—"}
      </span>
      <span role="cell" className="api-key-when">
        {item.lastUsedAt ? collectionTime(item.lastUsedAt) : t("Never used")}
      </span>
      <span role="cell" className="api-key-cost">
        {item.totalCost === undefined ? "—" : cost(item.totalCost)}
      </span>
      <span role="cell" className="api-key-actions">
        <button
          type="button"
          className="routine-more"
          aria-label={`${item.name} actions`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => onMenu(event.currentTarget)}
        >
          <EllipsisVertical size={16} strokeWidth={1.6} />
        </button>
      </span>
    </div>
  );
}

/**
 * Where requests with these keys go, one copyable address per protocol:
 * OpenAI-compatible clients take the service's address with /v1, Anthropic
 * clients the address alone. Each row is named by the protocol it speaks, with
 * no vendor logo.
 */
function RequestUrl({ origin: serviceOrigin }: { origin?: string }) {
  useT();
  // The web app is served by the service itself.
  const origin = surface === "web" ? location.origin : (serviceOrigin ?? "");
  if (!origin) return null;
  return (
    <div className="api-request-url">
      <span className="api-request-label">Request URL</span>
      <RequestUrlRow name="OpenAI-compatible URL" url={`${origin}/v1`} />
      <RequestUrlRow name="Messages API URL" url={origin} />
    </div>
  );
}

function RequestUrlRow({ name, url }: { name: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="api-request-box">
      <span className="api-request-vendor">{name}</span>
      <code data-no-translate>{url}</code>
      <button
        type="button"
        className="api-request-copy"
        onClick={() =>
          void api.copyText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </span>
  );
}
