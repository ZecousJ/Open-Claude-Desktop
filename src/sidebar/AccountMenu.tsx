import {
  Suspense,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ShortcutPlatform, shortcutText } from "../ui/Tooltip";
import { createPortal } from "react-dom";
import { surface } from "../../shared/host";
import { helpUrl } from "../../shared/help-links";
import { AppContext } from "../app/AppContext";
import type { Conversation, Mode } from "../../shared/types";
import { lazyPiece } from "../ui/lazy-piece";
import { AppIcon, type AppIconName } from "../ui/app-icon";
import { IconButton } from "../ui/Controls";
import { SearchIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";
import { useT } from "../i18n";
import { profileInitials } from "./profile";
import { menuItems, roamMenuItems } from "./menu-keys";
import { openLanguageDialog } from "../i18n/language-dialog";
import { usePolicy } from "../policy/PolicyContext";
import { DownloadTrayIcon } from "../policy/policy-icons";
import { UpdateNotice, useUpdateNotice } from "../policy/UpdateNotice";
import "../policy/policy.css";
import {
  RelaunchToUpdate,
  UpdateStatusStrip,
} from "../updates/RelaunchToUpdate";
import {
  relaunchReady,
  selfUpdating,
  useAppUpdate,
  useRecheckForRelease,
} from "../updates/useAppUpdate";

const web = surface === "web";
// The Code-only reporting protocol need not delay the first Chat screen.
// Its disabled32px Ant placeholder has the same bounds while loading.
const CodeFeedbackFooter = lazyPiece(
  () => import("./CodeFeedbackFooter"),
  "CodeFeedbackFooter",
);

/**
 * A menu row's glyph: the icon font's own, 20px on the web and 16px on the
 * desktop.
 */
const glyph = (name: AppIconName) => (
  <AppIcon name={name} size={web ? 20 : 16} />
);

/** An external link ends in ArrowOutSquare (the bundle's `trailing`). */
const external = (
  <AppIcon name="ArrowOutSquare" size="sm" className="profile-external" />
);

/** The CDS scroll layer owns the web menu's gutter and bottom sizing ring. */
function AccountMenuScroll({ children }: { children: ReactNode }) {
  return web ? <div className="profile-menu-scroll">{children}</div> : children;
}

/**
 * Account button at the foot of the sidebar and its menu. Get help, Get apps
 * and extensions and Learn more appear only when the administrator set their
 * pages (the policy's links). View all plans is the recharge entry, Add funds,
 * for a service account, and the administrator's plans page otherwise; Language
 * opens the language dialog (src/i18n). The plan label is the policy's plan
 * label; without one there is none.
 *
 * The glyph right of the button: with a newer build published it is the
 * download glyph and opens the update notice; otherwise, in Chat and Cowork,
 * the download glyph opens Get apps and extensions when the administrator named
 * that page, and there is none otherwise. Code's Ant glyph opens session
 * feedback through the consented service collector.
 *
 * When Claudex updates itself the notice and glyph give way: "Relaunch to
 * update" sits above the account row once the update is staged.
 *
 * On the web (W-UI-design §3.4) a page load is always the latest version, so
 * there is no update notice, glyph or relaunch. The row ends with the download
 * glyph for the desktop app (Chat and Cowork, only when the administrator set
 * its page) and a search button, since ⌘K can belong to the browser. Settings
 * has no shortcut there (⌘, opens the browser's).
 *
 * The menu opens with the account's email; switching or adding accounts is not
 * offered.
 */
export function AccountMenu({
  name,
  avatar,
  avatarPhoto,
  email,
  plan,
  mode,
  conversation,
  onSearch,
  onSettings,
  onUsage,
  onRecharge,
  onChangelog,
  onSignOut,
  onError,
}: {
  name: string;
  avatar?: number;
  avatarPhoto?: string;
  email?: string;
  plan?: string;
  /** Code uses session feedback in its separate footer slot. */
  mode: Mode;
  conversation?: Conversation;
  /** Opens the search palette from the footer. */
  onSearch?: () => void;
  onSettings: () => void;
  onUsage?: () => void;
  /**
   * The recharge entry where the original has View all plans: Settings >
   * Billing's Add funds. Given for every service account.
   */
  onRecharge?: () => void;
  onChangelog: () => void;
  onSignOut?: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const platform = useContext(ShortcutPlatform);
  const app = useContext(AppContext);
  const t = useT();
  const [position, setPosition] = useState<{ left: number; bottom: number }>();
  const [learnMore, setLearnMore] = useState<{
    left: number;
    top: number;
    /** The Learn more row's bottom edge, for opening upwards. */
    rowBottom: number;
  }>();
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const profileButton = useRef<HTMLButtonElement>(null);
  // Opened from the keyboard, the first item takes focus.
  const openedByKey = useRef(false);
  const submenu = useRef<HTMLDivElement>(null);
  const learnMoreAnchor = useRef<HTMLElement | null>(null);
  const open = position !== undefined;
  // Opened from the keyboard: the row that takes focus (↓ first, ↑ last).
  const [entry, setEntry] = useState<"first" | "last">();
  const close = () => {
    // Focus inside the menu goes back to the account button.
    if (
      menu.current?.contains(document.activeElement) ||
      submenu.current?.contains(document.activeElement)
    )
      trigger.current?.focus();
    setPosition(undefined);
    setLearnMore(undefined);
    setEntry(undefined);
  };
  useEffect(() => {
    if (!position || !entry || !menu.current) return;
    const rows = menuItems(menu.current);
    rows[entry === "first" ? 0 : rows.length - 1]?.focus();
  }, [position, entry]);
  useDismiss([anchor, menu, submenu], open, close);
  useEffect(() => {
    if (!open || !openedByKey.current) return;
    openedByKey.current = false;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const { links, update: serviceUpdate } = usePolicy();
  const help = links.help || helpUrl("support");
  const learnMoreLinks = links.learnMore.length
    ? links.learnMore
    : [
        { label: "About Claudex", url: helpUrl() },
        { label: "Usage policy", url: helpUrl("usage-policy") },
      ];
  // While Claudex downloads or has staged the update itself, Relaunch to update
  // replaces the download notice and glyph.
  const appUpdate = useAppUpdate();
  useRecheckForRelease(web ? undefined : appUpdate, serviceUpdate);
  const update =
    web || selfUpdating(appUpdate, serviceUpdate) ? undefined : serviceUpdate;
  const apps = links.apps;
  const notice = useUpdateNotice(update);
  const run = (action: () => void) => () => {
    close();
    action();
  };
  const visit = (url: string) =>
    run(() => void window.desktop.openExternal(url).catch(onError));
  const openAt = (button: HTMLElement) => {
    const box = button.getBoundingClientRect();
    // Measured: flush with the button's left edge, 6px above it.
    setPosition({
      left: box.left,
      bottom: window.innerHeight - box.top + 6,
    });
  };
  const hideLearnMore = () => setLearnMore(undefined);
  const showLearnMore = (row: HTMLElement) => {
    learnMoreAnchor.current = row;
    const box = row.getBoundingClientRect();
    const frame = menu.current!.getBoundingClientRect();
    // Like the sidebar filter submenus: 2px right of the menu, first row level with this one.
    setLearnMore({
      left: frame.right + 2,
      top: box.top - 5,
      rowBottom: box.bottom,
    });
  };
  // Near the bottom of the window the submenu opens upwards, its last row
  // level with Learn more, and never leaves the window.
  useLayoutEffect(() => {
    const element = submenu.current;
    if (!element || !learnMore) return;
    const margin = 8,
      height = element.offsetHeight;
    if (learnMore.top + height <= window.innerHeight - margin) return;
    const top = Math.max(
      margin,
      Math.min(learnMore.rowBottom + 5, window.innerHeight - margin) - height,
    );
    if (top !== learnMore.top) setLearnMore({ ...learnMore, top });
  }, [learnMore]);
  return (
    <>
      {!web &&
        appUpdate?.manual &&
        (appUpdate.phase === "checking" ||
          appUpdate.phase === "downloading") && (
          <UpdateStatusStrip phase={appUpdate.phase} />
        )}
      {!web && relaunchReady(appUpdate) && (
        <RelaunchToUpdate
          version={appUpdate!.version!}
          retry={appUpdate!.retry}
          onError={onError}
        />
      )}
      {notice.shown && update && (
        <UpdateNotice
          update={update}
          onDismiss={notice.dismiss}
          onError={onError}
        />
      )}
      <div className="profile-wrap" ref={anchor}>
        <button
          ref={trigger}
          className={`profile ${open ? "open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const first = event.key === "ArrowDown";
            if (open && menu.current) {
              const rows = menuItems(menu.current);
              rows[first ? 0 : rows.length - 1]?.focus();
              return;
            }
            openAt(event.currentTarget);
            setEntry(first ? "first" : "last");
          }}
          onClick={(event) => {
            if (open) return close();
            openAt(event.currentTarget);
            // Enter and Space click with no pointer: focus goes into the menu.
            if (event.detail === 0) setEntry("first");
          }}
        >
          <span className="profile-avatar-slot">
            <span className="avatar" aria-hidden="true">
              {avatarPhoto || avatar ? (
                <img
                  src={
                    avatarPhoto ||
                    `${import.meta.env?.BASE_URL ?? "/"}avatars/${avatar}.svg`
                  }
                  width={20}
                  height={20}
                  alt=""
                  style={{ borderRadius: "50%" }}
                />
              ) : (
                profileInitials(name || email || "")
              )}
            </span>
          </span>
          <span data-no-translate>
            {name || email}
            {plan && <small> · {plan}</small>}
          </span>
          <AppIcon name="CaretDown" size="xs" />
        </button>
        {update ? (
          <IconButton
            label={
              update.state === "required"
                ? t("Update required")
                : t("Update available")
            }
            className={`account-update ${update.state}`}
            onClick={notice.show}
          >
            <DownloadTrayIcon />
          </IconButton>
        ) : (
          !web &&
          apps &&
          mode !== "code" && (
            <IconButton
              label={
                web ? t("Get the desktop app") : t("Get apps and extensions")
              }
              className="account-apps"
              onClick={() =>
                void window.desktop.openExternal(apps).catch(onError)
              }
            >
              <DownloadTrayIcon />
            </IconButton>
          )
        )}
        {onSearch && (
          <IconButton
            label={t("Search")}
            shortcut={["mod", "K"]}
            className="account-search"
            onClick={onSearch}
          >
            <SearchIcon />
          </IconButton>
        )}
        {mode === "code" && (
          <Suspense
            fallback={
              <IconButton
                label={t("Send feedback")}
                className="account-code-feedback"
                disabled
                title={
                  !conversation
                    ? t("Open a session to send feedback.")
                    : t("Feedback isn’t available for this session.")
                }
              >
                <AppIcon name="Ant" size={20} />
              </IconButton>
            }
          >
            <CodeFeedbackFooter
              conversation={conversation}
              accountId={app?.accountId ?? "local"}
              consent={app?.snapshot?.settings?.helpImproveClaudex}
            />
          </Suspense>
        )}
        {open &&
          createPortal(
            // Wider than the sidebar, which clips its overflow.
            <div
              ref={menu}
              className="popover profile-popover"
              role="menu"
              style={position}
              onKeyDown={(event) => roamMenuItems(event, close)}
            >
              <AccountMenuScroll>
                {email && <header>{email}</header>}
                <button
                  role="menuitem"
                  onMouseEnter={hideLearnMore}
                  onClick={run(onSettings)}
                >
                  {glyph("Settings")}
                  <span>{t("Settings")}</span>
                  <kbd>
                    {shortcutText(
                      platform,
                      web ? ["shift", "mod", ","] : ["mod", ","],
                    )}
                  </kbd>
                </button>
                {onUsage && (
                  <button
                    role="menuitem"
                    onMouseEnter={hideLearnMore}
                    onClick={run(onUsage)}
                  >
                    {glyph("UsageGaugeMiddle")}
                    <span>{t("Usage")}</span>
                  </button>
                )}
                <button
                  role="menuitem"
                  onMouseEnter={hideLearnMore}
                  onClick={run(() => openLanguageDialog())}
                >
                  {glyph("Globe")}
                  <span>{t("Language")}</span>
                </button>
                {help && (
                  <button
                    role="menuitem"
                    onMouseEnter={hideLearnMore}
                    onClick={visit(help)}
                  >
                    {glyph("Help")}
                    <span>{t("Get help")}</span>
                    {external}
                  </button>
                )}
                <hr />
                {onRecharge ? (
                  <button
                    role="menuitem"
                    onMouseEnter={hideLearnMore}
                    onClick={run(onRecharge)}
                  >
                    {glyph("Checklist")}
                    <span>{t("Add funds")}</span>
                  </button>
                ) : (
                  links.plans && (
                    <button
                      role="menuitem"
                      onMouseEnter={hideLearnMore}
                      onClick={visit(links.plans)}
                    >
                      {glyph("Checklist")}
                      <span>{t("View all plans")}</span>
                    </button>
                  )
                )}
                {links.apps && (
                  <button
                    role="menuitem"
                    onMouseEnter={hideLearnMore}
                    onClick={visit(links.apps)}
                  >
                    {glyph("CirclesAdd")}
                    <span>{t("Get apps and extensions")}</span>
                  </button>
                )}
                {!web && (
                  <button
                    role="menuitem"
                    onMouseEnter={hideLearnMore}
                    onClick={run(onChangelog)}
                  >
                    {glyph("Scroll")}
                    <span>{t("View changelog")}</span>
                  </button>
                )}
                {learnMoreLinks.length > 0 && (
                  <button
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={Boolean(learnMore)}
                    className={learnMore ? "open" : ""}
                    onMouseEnter={(event) => showLearnMore(event.currentTarget)}
                    onClick={(event) => showLearnMore(event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowRight") return;
                      event.preventDefault();
                      showLearnMore(event.currentTarget);
                      requestAnimationFrame(() =>
                        submenu.current
                          ?.querySelector<HTMLButtonElement>("button")
                          ?.focus(),
                      );
                    }}
                  >
                    {glyph("Info")}
                    <span>{t("Learn more")}</span>
                    <AppIcon
                      name="CaretRight"
                      size="sm"
                      className="profile-submenu-chevron"
                    />
                  </button>
                )}
                {app && (
                  <>
                    <hr />
                    <button
                      role="menuitem"
                      onMouseEnter={hideLearnMore}
                      onClick={run(() => app.setPage("api"))}
                    >
                      {glyph("Key")}
                      <span>{t("Get API keys")}</span>
                    </button>
                  </>
                )}
                {onSignOut && (
                  <>
                    <hr />
                    <button
                      role="menuitem"
                      onMouseEnter={hideLearnMore}
                      onClick={run(() => void onSignOut().catch(onError))}
                    >
                      {glyph("Logout")}
                      <span>{t("Log out")}</span>
                    </button>
                  </>
                )}
              </AccountMenuScroll>
            </div>,
            document.body,
          )}
        {open &&
          learnMore &&
          createPortal(
            <div
              ref={submenu}
              className="popover profile-popover profile-submenu"
              role="menu"
              aria-label={t("Learn more")}
              style={{ left: learnMore.left, top: learnMore.top }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  hideLearnMore();
                  learnMoreAnchor.current?.focus();
                } else roamMenuItems(event, close);
              }}
            >
              <AccountMenuScroll>
                {learnMoreLinks.map((link) => (
                  <button
                    key={link.url + link.label}
                    role="menuitem"
                    onClick={visit(link.url)}
                  >
                    <span>{t(link.label)}</span>
                    {external}
                  </button>
                ))}
                {app && (
                  <>
                    <button
                      role="menuitem"
                      onClick={run(() => app.openSettingsTab("privacy"))}
                    >
                      <span>{t("Your privacy choices")}</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={run(() => app.setShortcutsOpen(true))}
                    >
                      <span>{t("Keyboard shortcuts")}</span>
                    </button>
                  </>
                )}
              </AccountMenuScroll>
            </div>,
            document.body,
          )}
      </div>
    </>
  );
}
