import { settingsConnectorFromSearch, type RouteState } from "./routes";
import {
  pairedArtifactRouteId,
  resolvePairedArtifact,
} from "../artifacts/paired-artifact";
import { deferFileTransition } from "../files/file-transitions";
import type { Mode } from "../../shared/types";
import { type AppController } from "../app/AppContext";
import {
  requestProject,
  requestSharedChat,
} from "../collections/open-requests";
import { openAddressPrompt } from "../cowork/prompt-links";
import {
  formatWebRoute,
  isDraftUrl,
  parseWebRoute,
  urlForState,
  type WebRoute,
} from "./routes";

import type { SyncedPlace } from "./useWebRoute";

/**
 * What a move of the window does to the browser history:
 * - `none`: the address already says it, or the place has no address;
 * - `replace`: a page switch inside Settings, the draft becoming the
 *   conversation it started, or Settings closing when it was opened
 *   straight from the address;
 * - `back`: Settings closing, back to the entry it was opened over;
 * - `push`: any other move.
 */
export function historyStep({
  previous,
  next,
  address,
  openedSettings,
  activeId,
  draftKnown,
}: {
  previous: SyncedPlace;
  next: SyncedPlace;
  /** The address bar's path and query. */
  address: string;
  /** The current entry is Settings opened over the one before it. */
  openedSettings: boolean;
  /** The open conversation. */
  activeId?: string;
  /** Conversations that existed while the window showed the draft. */
  draftKnown: ReadonlySet<string> | null;
}): "none" | "push" | "replace" | "back" {
  const url = next.url;
  if (!url || url === address) return "none";
  const parsedAddress = new URL(address, "https://claudex.invalid");
  const addressed = parseWebRoute(parsedAddress.pathname, parsedAddress.search);
  // A task selected through Search may finish mounting after the page's
  // list target was computed. Keep the concrete selection it just opened.
  if (
    url === "/scheduled-task" &&
    addressed.kind === "page" &&
    addressed.page === "scheduled" &&
    addressed.taskId
  )
    return "none";
  if (
    url === "/customize" &&
    addressed.kind === "page" &&
    addressed.page === "customize" &&
    addressed.customize
  )
    return "none";
  // One project open on the Projects page keeps its address.
  if (
    ["/projects", "/cowork/projects"].includes(url) &&
    parseWebRoute(address.split("?")[0]).kind === "project"
  )
    return "none";
  if (previous.settingsOpen && next.settingsOpen) return "replace";
  if (next.settingsOpen) return "push";
  if (previous.settingsOpen) return openedSettings ? "back" : "replace";
  const started =
    isDraftUrl(previous.url) &&
    !isDraftUrl(url) &&
    activeId !== undefined &&
    draftKnown !== null &&
    !draftKnown.has(activeId);
  return started ? "replace" : "push";
}

/**
 * Shows a route in the window. Returns the route's canonical address, or
 * undefined to leave the address as it is (not found). `initial` is the
 * page load (else back or forward); `codeAvailable` whether this host runs
 * Code conversations.
 */
export function applyRoute(
  app: AppController,
  route: WebRoute,
  {
    codeAvailable,
    initial,
    current: stillCurrent,
    onDeferred,
    onCancel,
  }: {
    codeAvailable: boolean;
    initial: boolean;
    current?: () => boolean;
    onDeferred?: (waiting: boolean) => void;
    onCancel?: () => void;
  },
): string | undefined {
  const owner = app.accountId,
    controller = app.controllerScope;
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const routeCurrent = () => {
    const now = app.currentController?.current ?? app;
    return Boolean(
      now &&
      now.accountId === owner &&
      now.controllerScope === controller &&
      (typeof window === "undefined" || window.desktop === bridge) &&
      (!stillCurrent || stillCurrent()),
    );
  };
  // The page under Settings, if it is open.
  const current = urlForState({ ...routeState(app), settingsOpen: false });
  const chatMode: Mode = app.mode === "code" ? "chat" : app.mode;
  if (route.kind === "settings") {
    const tab = route.tab ?? "general";
    // Opened straight from the address: the page under it is a new chat.
    // Forward into Settings keeps the page it was opened over.
    const background =
      route.background ??
      (!initial
        ? (() => {
            const url = new URL(current ?? "/new", "https://claudex.invalid");
            return parseWebRoute(url.pathname, url.search);
          })()
        : { kind: "new" as const });
    if (
      formatWebRoute(background) !== current ||
      (initial && background.kind === "new")
    )
      applyRoute(app, background, {
        codeAvailable,
        initial,
        current: stillCurrent,
        onDeferred,
        onCancel,
      });
    if (!app.settingsOpen || app.settingsTab !== tab) app.openSettingsTab(tab);
    return formatWebRoute({
      kind: "settings",
      tab,
      background,
      ...(route.connector ? { connector: route.connector } : {}),
    });
  }
  if (app.settingsOpen) app.setSettingsOpen(false);
  if (route.kind !== "code-search" && app.search !== null) app.setSearch(null);
  const show = (
    url: string | undefined,
    change: () => void,
    initializeHome = false,
  ) => {
    if (url !== current || (initial && initializeHome)) change();
    return url;
  };
  switch (route.kind) {
    case "root":
    case "sign-in":
      return show("/new", () => app.newChat(chatMode), true);
    case "new": {
      if (route.incognito && app.policy.incognito)
        return show("/new?incognito", () =>
          app.newChat("chat", undefined, true),
        );
      if (route.prompt) {
        // Filled in, never sent; the text leaves the address.
        const prompt = route.prompt;
        app.newChat(chatMode);
        // On the Cowork home it opens a quick task window while there is room,
        // with the caution band of a prompt from outside.
        if (chatMode !== "cowork" || !openAddressPrompt(prompt))
          app.setText(prompt);
        return "/new";
      }
      return show("/new", () => app.newChat(chatMode), true);
    }
    case "code":
      if (!codeAvailable) return show("/new", () => app.newChat("chat"));
      return show("/code", () => app.newChat("code"));
    case "code-search":
      if (!codeAvailable) return show("/new", () => app.newChat("chat"));
      if (app.mode !== "code") app.newChat("code");
      if (app.search === null) app.setSearch("");
      return "/code/search";
    case "chat":
    case "code-chat": {
      const conversation = app.snapshot.conversations.find(
        (c) => c.id === route.id && !c.incognito,
      );
      // Gone (deleted, another account's, or an incognito chat that ended): as
      // the original, an error notice and the address replaced by a new one,
      // not a "Page not found".
      if (!conversation) {
        if (route.kind === "code-chat" && codeAvailable) {
          app.report(new Error("That session is no longer available."));
          return show("/code", () => app.newChat("code"));
        }
        app.report(
          new Error("That chat is no longer available. Starting a new one."),
        );
        return show("/new", () => app.newChat(chatMode));
      }
      const artifact =
        route.kind === "chat" &&
        route.artifactId &&
        conversation.mode !== "code"
          ? resolvePairedArtifact(
              app.snapshot,
              conversation.id,
              route.artifactId,
            )
          : undefined;
      const wanted = artifact
        ? pairedArtifactRouteId(artifact, conversation.id)
        : undefined;
      const url = formatWebRoute({
        kind: conversation.mode === "code" ? "code-chat" : "chat",
        id: conversation.id,
        ...(wanted ? { artifactId: wanted } : {}),
      });
      if (
        route.kind === "chat" &&
        route.artifactId &&
        !artifact &&
        conversation.mode !== "code"
      )
        app.report(
          new Error("This artifact is not available in this account."),
        );
      return show(
        url,
        () => {
          if (conversation.mode === "code")
            return app.openConversation(conversation);
          const paired = Boolean(
            conversation.blankArtifact ||
            (route.kind === "chat" && route.artifactId) ||
            pairedArtifactRouteId(app.artifact, conversation.id),
          );
          if (!paired) return app.openConversation(conversation);
          const commit = () => {
            if (!routeCurrent()) return;
            if (
              app.activeId === conversation.id &&
              app.page === "chat" &&
              app.mode === conversation.mode
            )
              app.setArtifact(artifact);
            else
              app.openConversation(conversation, {
                artifactId: wanted ?? null,
              });
          };
          if (
            deferFileTransition(
              () => {
                onDeferred?.(false);
                commit();
              },
              "session",
              onCancel,
            )
          ) {
            onDeferred?.(true);
            return;
          }
          commit();
        },
        true,
      );
    }
    case "page": {
      const wantCode = route.surface === "code" && codeAvailable;
      const url = formatWebRoute({
        ...route,
        surface: wantCode ? "code" : undefined,
      });
      return show(url, () => {
        if (wantCode && app.mode !== "code") app.setMode("code");
        if (!wantCode && app.mode === "code") app.setMode("chat");
        if (route.page === "projects") requestProject();
        app.setPage(route.page);
      });
    }
    case "project": {
      // The project page distinguishes failed reads from a genuinely missing
      // record. A missing item in a cached catalogue is not a route failure.
      if (app.mode === "code" && !codeAvailable) app.setMode("chat");
      requestProject(route.id);
      app.setPage("projects");
      return formatWebRoute(route);
    }
    case "shared": {
      if (app.mode === "code") app.setMode("chat");
      requestSharedChat(route.token);
      app.setPage("shared");
      return formatWebRoute(route);
    }
    case "artifact":
      app.setArtifactRouteId?.(route.id);
      if (app.mode === "code") app.setMode("chat");
      app.setPage("artifact");
      return formatWebRoute(route);
    default:
      app.setPage("not-found");
      return undefined;
  }
}

export function routeState(app: AppController): RouteState {
  const address =
    typeof location === "undefined"
      ? undefined
      : parseWebRoute(location.pathname, location.search);
  return {
    page: app.page,
    mode: app.mode,
    conversationId: app.activeId,
    conversationMode: app.active?.mode,
    incognitoShown: app.incognitoShown,
    artifactId: app.artifactRouteId,
    pairedArtifactId: pairedArtifactRouteId(app.artifact, app.activeId),
    settingsOpen: app.settingsOpen,
    settingsTab: app.settingsTab,
    settingsConnector:
      typeof location === "undefined"
        ? undefined
        : settingsConnectorFromSearch(location.search),
    searchOpen: app.search !== null,
    projectId:
      app.page === "projects" && address?.kind === "project"
        ? address.id
        : undefined,
    scheduledView:
      app.page === "scheduled" &&
      address?.kind === "page" &&
      address.page === "scheduled"
        ? address.view
        : undefined,
    scheduledTaskId:
      app.page === "scheduled" &&
      address?.kind === "page" &&
      address.page === "scheduled"
        ? address.taskId
        : undefined,
    customizePlace:
      app.page === "customize" &&
      address?.kind === "page" &&
      address.page === "customize"
        ? address.customize
        : undefined,
  };
}
