import { t } from "../i18n";
import { BrowserTabStrip } from "./BrowserTabStrip";
import { DevServersIcon } from "./icons";
import { EllipsisVertical, Minimize2, Maximize2, X } from "../ui/glyphs";
import { AddressBar } from "./AddressBar";
import { tabShowsPage, openableElsewhere } from "./browser-model";
import { errorText } from "./useBrowserState";
import {
  BlockedSiteStrip,
  BrowserNotices,
  BrowserErrorState,
} from "./BrowserErrorState";
import {
  RestoredPreview,
  SettingUpPreview,
  DevServerFailedCard,
  DevServerNotStarted,
  BrowserToolsOff,
  DevServerStoppedCard,
} from "./PreviewStatus";
import { BrowserEmptyState } from "./BrowserEmptyState";
import { Suspense } from "react";
import { BrowserSketch, menuLabels, ChromeImportDialog } from "./BrowserPanel";
import {
  DevServerLogsDrawer,
  StartServerDialog,
  CloseRunningTabDialog,
} from "./DevServerDialogs";
import { Menu } from "../ui/Menu";
import { AddServerDialog } from "./AddServerDialog";
import { keepCookiesOf } from "../../shared/browser";
import { AllowedSitesDialog } from "../settings/AllowedSitesDialog";
import type { BrowserBridge } from "./useBrowserState";
import type { Conversation } from "../../shared/types";
import type {
  OpenDialog,
  BrowserPanelEnv,
  OpenMenu,
  PreviewProblem,
} from "./BrowserPanel";
import type {
  DevServerState,
  BrowserState,
  BrowserTabState,
  BrowserViewport,
} from "../../shared/browser";
import type { MenuEntry } from "../ui/Menu";
import type { SketchBackdrop, SketchHandle } from "./BrowserSketch";

/** What browserPanelView needs from BrowserPanel.tsx. */
export interface BrowserPanelViewKit {
  address: React.RefObject<HTMLInputElement | null>;
  allowedSites: string[];
  attachSketch: (
    png: Uint8Array<ArrayBufferLike>,
    name: string,
  ) => Promise<void>;
  below: (
    button: HTMLElement | null,
    alignTo?: HTMLElement | null | undefined,
  ) => { right: number; top: number };
  bridge: BrowserBridge | undefined;
  browserName: string | null;
  closeAction: React.RefObject<(() => Promise<unknown>) | undefined>;
  closeTabs: (
    tabIds: string[],
    others: boolean,
    keepId?: string | undefined,
  ) => void;
  conversation: Conversation;
  cover: { on: boolean; snapshot?: string | undefined };
  detect: () => void;
  detecting: boolean;
  devButton: React.RefObject<HTMLButtonElement | null>;
  dialog: OpenDialog | undefined;
  drawerServer: DevServerState | undefined;
  emptyTab: boolean;
  env: BrowserPanelEnv;
  expanded: boolean;
  failure: string | undefined;
  id: string;
  menu: OpenMenu | undefined;
  menuEntries: () => MenuEntry[];
  message: string;
  moreButton: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onError: (error: unknown) => void;
  openWhenRunning: string | undefined;
  pick: () => void;
  place: React.RefObject<HTMLDivElement | null>;
  platform: string;
  policyAllowsTools: boolean;
  problem: PreviewProblem | undefined;
  retry: (name: string) => void;
  retrying: string | undefined;
  run: (work: () => Promise<unknown> | undefined) => void;
  setDialog: React.Dispatch<React.SetStateAction<OpenDialog | undefined>>;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setLogsFor: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMenu: React.Dispatch<React.SetStateAction<OpenMenu | undefined>>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setProblem: React.Dispatch<React.SetStateAction<PreviewProblem | undefined>>;
  setSketch: React.Dispatch<React.SetStateAction<SketchBackdrop | undefined>>;
  settings: Record<string, unknown>;
  showsError: boolean;
  sketch: SketchBackdrop | undefined;
  sketchHandle: React.RefObject<SketchHandle | null>;
  startApproved: React.RefObject<boolean>;
  startServer: (name: string) => Promise<void>;
  state: BrowserState | undefined;
  stoppedServer: DevServerState | undefined;
  tab: BrowserTabState | undefined;
  toggleSketch: () => void;
  touchId: boolean;
  viewport: BrowserViewport;
}

export function browserPanelView(kit: BrowserPanelViewKit) {
  const {
    address,
    allowedSites,
    attachSketch,
    below,
    bridge,
    browserName,
    closeAction,
    closeTabs,
    conversation,
    cover,
    detect,
    detecting,
    devButton,
    dialog,
    drawerServer,
    emptyTab,
    env,
    expanded,
    failure,
    id,
    menu,
    menuEntries,
    message,
    moreButton,
    onClose,
    onError,
    openWhenRunning,
    pick,
    place,
    platform,
    policyAllowsTools,
    problem,
    retry,
    retrying,
    run,
    setDialog,
    setExpanded,
    setLogsFor,
    setMenu,
    setMessage,
    setProblem,
    setSketch,
    settings,
    showsError,
    sketch,
    sketchHandle,
    startApproved,
    startServer,
    state,
    stoppedServer,
    tab,
    toggleSketch,
    touchId,
    viewport,
  } = kit;
  const browserPanelViewView = (
    <aside
      className={`work-panel browser-panel${env.split ? " split" : ""}${expanded ? " expanded" : ""}`}
      aria-label={state && !state.toolsAvailable ? t("Preview") : t("Browser")}
      data-browser-conversation={id}
    >
      <header>
        {state ? (
          <BrowserTabStrip
            tabs={state.tabs}
            activeTabId={state.activeTabId}
            onSelect={(tabId) => run(() => bridge?.browserSelectTab(id, tabId))}
            onClose={(tabId) => closeTabs([tabId], false)}
            onNewTab={() =>
              run(async () => {
                await bridge?.browserNewTab(id);
                address.current?.focus();
              })
            }
            onContextMenu={(tabId, x, y) =>
              setMenu({ kind: "tab", tabId, position: { left: x, top: y } })
            }
          />
        ) : (
          <div className="browser-tabs" />
        )}
        {state?.devServersAvailable && (
          <button
            ref={devButton}
            className="browser-icon-button"
            aria-label="Dev servers"
            title="Dev servers"
            aria-haspopup="menu"
            aria-expanded={menu?.kind === "dev"}
            onClick={() =>
              setMenu(
                menu?.kind === "dev"
                  ? undefined
                  : { kind: "dev", position: below(devButton.current) },
              )
            }
          >
            <DevServersIcon />
          </button>
        )}
        <button
          ref={moreButton}
          className="browser-icon-button"
          aria-label="Browser settings"
          title="Browser settings"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "settings" || menu?.kind === "cookies"}
          disabled={!state}
          onClick={() =>
            setMenu(
              menu?.kind === "settings" || menu?.kind === "cookies"
                ? undefined
                : {
                    kind: "settings",
                    position: below(moreButton.current, address.current),
                  },
            )
          }
        >
          <EllipsisVertical size={14} strokeWidth={1.75} />
        </button>
        <button
          className="browser-icon-button"
          aria-label={expanded ? "Collapse" : "Expand"}
          title={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
        <button
          className="browser-icon-button"
          aria-label="Close browser"
          title="Close"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      <AddressBar
        key={tab?.id ?? "none"}
        tab={tab}
        picking={Boolean(state?.picking)}
        canPick={tabShowsPage(tab)}
        inputRef={address}
        onNavigate={async (text) => {
          if (!bridge) return false;
          try {
            const result = await bridge.browserNavigate(id, text, tab?.id);
            setMessage(result.ok ? "" : result.message);
            return result.ok;
          } catch (error) {
            setMessage(errorText(error));
            return false;
          }
        }}
        onBack={() => run(() => bridge?.browserBack(id))}
        onForward={() => run(() => bridge?.browserForward(id))}
        onReload={() => run(() => bridge?.browserReload(id))}
        onOpenExternal={
          openableElsewhere(tab)
            ? () => run(() => bridge?.browserOpenExternally(id))
            : undefined
        }
        onStop={() => run(() => bridge?.browserStop(id))}
        onPick={pick}
        sketching={Boolean(sketch)}
        onEndSketch={toggleSketch}
      />
      {message && (
        <div className="browser-notice browser-address-message" role="status">
          <span>{message}</span>
          <button onClick={() => setMessage("")}>Dismiss</button>
        </div>
      )}
      {tab?.error?.description === "BLOCKED_BY_ADMINISTRATOR" && (
        <BlockedSiteStrip />
      )}
      <BrowserNotices
        tab={tab}
        picking={Boolean(state?.picking)}
        onCancelPick={() => run(() => bridge?.browserCancelPick(id))}
        onStop={() => run(() => bridge?.browserStop(id))}
        onAnswer={(accept, text) =>
          tab &&
          run(() => bridge?.browserAnswerDialog(id, tab.id, accept, text))
        }
      />
      <div
        ref={place}
        className={`browser-viewport${viewport !== "desktop" ? " mobile" : ""}`}
      >
        {tab?.restored && (
          <RestoredPreview
            tab={tab}
            busy={Boolean(retrying)}
            onRestart={() => {
              const server = state?.devServers.find(
                (server) => server.name === tab.restored?.serverName,
              );
              if (server) retry(server.name);
              else run(() => bridge?.browserNavigate(id, tab.url));
            }}
            onDismiss={() => run(() => bridge?.browserShowStartPage(id))}
          />
        )}
        {cover.on && cover.snapshot && tabShowsPage(tab) && (
          <img className="browser-snapshot" src={cover.snapshot} alt="" />
        )}
        {!state && (
          <div className="browser-empty">
            {failure ? <p role="alert">{failure}</p> : null}
          </div>
        )}
        {emptyTab && state && openWhenRunning && <SettingUpPreview />}
        {emptyTab &&
          state &&
          !openWhenRunning &&
          problem?.kind === "start-failed" && (
            <DevServerFailedCard
              message={problem.message}
              busy={retrying === problem.name}
              onRetry={() => retry(problem.name)}
            />
          )}
        {emptyTab &&
          state &&
          !openWhenRunning &&
          problem?.kind === "not-started" && (
            <DevServerNotStarted
              busy={false}
              onRetry={() => {
                const server = state.devServers.find(
                  (s) => s.name === problem.name,
                );
                if (server) setDialog({ kind: "start", server });
              }}
            />
          )}
        {emptyTab &&
          state &&
          !openWhenRunning &&
          !problem &&
          (!state.toolsAvailable && policyAllowsTools ? (
            <BrowserToolsOff
              onTurnOn={() =>
                run(() => env.onPreference({ browserTools: true }))
              }
            />
          ) : (
            <BrowserEmptyState
              toolsAvailable={state.toolsAvailable}
              onDetect={state.devServersAvailable ? detect : undefined}
              detecting={detecting}
            />
          ))}
        {state && tab && stoppedServer && (
          <DevServerStoppedCard
            name={stoppedServer.name}
            busy={retrying === stoppedServer.name}
            onRestart={() => retry(stoppedServer.name)}
          />
        )}
        {state && tab && showsError && !stoppedServer && (
          <BrowserErrorState
            tab={tab}
            browserName={browserName}
            onRetry={() => run(() => bridge?.browserReload(id))}
            onOpenElsewhere={
              openableElsewhere(tab)
                ? () => run(() => bridge?.browserOpenExternally(id))
                : undefined
            }
          />
        )}
        {sketch && (
          <Suspense fallback={null}>
            <BrowserSketch
              backdrop={sketch}
              handle={sketchHandle}
              platform={platform}
              onAttach={attachSketch}
              onError={(text: string) => env.onNotify(text)}
              onClose={() => setSketch(undefined)}
            />
          </Suspense>
        )}
      </div>
      {drawerServer && bridge && (
        <DevServerLogsDrawer
          server={drawerServer}
          onRead={() => bridge.devServersLogs(id, drawerServer.name, 500)}
          onClose={() => setLogsFor(undefined)}
        />
      )}
      {menu && state && (
        <Menu
          key={menu.kind}
          label={menuLabels[menu.kind]}
          entries={menuEntries()}
          position={menu.position}
          width={
            menu.kind === "settings" || menu.kind === "cookies" ? 231 : 220
          }
          anchors={[devButton, moreButton]}
          onClose={() => setMenu(undefined)}
        />
      )}
      {dialog?.kind === "add" && state && (
        <AddServerDialog
          initial={dialog.initial}
          note={dialog.note}
          existingNames={state.devServers
            .filter((server) => server.source === "launch.json")
            .map((server) => server.name)}
          onSave={async (config, start) => {
            if (!bridge) return;
            await bridge.devServersSave(id, config);
            // Saved: the dialog closes even if starting fails (the name now
            // exists, so saving again would be refused); the error shows.
            if (start) run(() => startServer(config.name));
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "start" && (
        <StartServerDialog
          server={dialog.server}
          folder={conversation.cwd}
          onStart={() => {
            startApproved.current = true;
            return startServer(dialog.server.name);
          }}
          onClose={() => {
            // Closed without starting: the empty tab says it needs approval.
            if (!startApproved.current)
              setProblem({ kind: "not-started", name: dialog.server.name });
            startApproved.current = false;
            setDialog(undefined);
          }}
        />
      )}
      {dialog?.kind === "close" && bridge && (
        <CloseRunningTabDialog
          servers={dialog.servers}
          others={dialog.others}
          onStop={async () => {
            try {
              await Promise.all(
                dialog.servers.map((server) =>
                  bridge.devServersStop(id, server.name),
                ),
              );
              await closeAction.current?.();
            } catch (error) {
              onError(new Error(errorText(error)));
            }
          }}
          onKeep={() => run(() => closeAction.current?.())}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog?.kind === "import" && bridge && (
        <Suspense fallback={null}>
          <ChromeImportDialog
            conversationId={id}
            api={bridge}
            persistent={
              conversation.mode === "cowork" ||
              keepCookiesOf(settings.browserKeepCookies) !== "until-quit"
            }
            touchId={touchId}
            useImported={dialog.useImported}
            onClose={() => setDialog(undefined)}
          />
        </Suspense>
      )}
      {dialog?.kind === "sites" && (
        <AllowedSitesDialog
          sites={allowedSites}
          externalSites={env.policy.externalSites !== false}
          blockedDomains={env.policy.blockedDomains}
          onAdd={(site) =>
            run(async () => {
              const result = await bridge!.addPreviewAllowedOrigin(site);
              if (result !== "ok")
                throw new Error(
                  t("This site is blocked by your organization’s policy."),
                );
            })
          }
          onRemove={(site) =>
            run(() => bridge!.removePreviewAllowedOrigin(site))
          }
          onClear={() => run(() => bridge!.clearPreviewAllowedOrigins())}
          onClose={() => setDialog(undefined)}
        />
      )}
    </aside>
  );
  return browserPanelViewView;
}
