import { useContext, useMemo, useRef } from "react";
import { AppContext } from "../app/AppContext";
import { formatText, t } from "../i18n";
import { usePluginOwner } from "./usePlugins";

/** O16 c89362a96:575–577; the generic path seeds a draft, never a turn. */
export const pluginChatPrompt =
  "I have the {pluginName} plugin. Please walk me through what it can do.";

const requests = new WeakMap<object, object>();

/** The runtime owns installation/enablement. A live listing proves whether
 * this account can try the plugin; no per-conversation plugin field is needed.
 * routeKey retires a Settings detail/filter or a routed Customize selection.
 */
export function useTryPluginChat({
  onError,
  routeKey,
}: {
  onError?: (error: unknown) => void;
  routeKey?: string;
} = {}) {
  const app = useContext(AppContext);
  const owner = usePluginOwner();
  const lease = useMemo(
    () => ({}),
    [
      owner.scope,
      routeKey,
      app?.page,
      app?.activeId,
      app?.draftSession,
      app?.mode,
      app?.settingsOpen,
    ],
  );
  const route = useRef(lease);
  route.current = lease;
  const report = useRef(onError);
  report.current = onError;
  if (!app) return undefined;
  return async (id: string, sourceCurrent?: () => boolean): Promise<void> => {
    const controller = () =>
      app.currentController ? app.currentController.current : app;
    const start = controller();
    const bridge = owner.bridge;
    if (
      !start ||
      !owner.current() ||
      route.current !== lease ||
      !bridge ||
      sourceCurrent?.() === false
    )
      return;
    const account = start.accountId;
    const scope = start.controllerScope;
    const requestOwner =
      start.controllerScope ?? start.currentController ?? app;
    const request = {};
    requests.set(requestOwner, request);
    const origin = {
      page: start.page,
      activeId: start.activeId,
      draftSession: start.draftSession,
      mode: start.mode,
      settingsOpen: start.settingsOpen,
      url: window.location?.href,
    };
    const sameAccount = () => {
      const now = controller();
      return Boolean(
        owner.ownsAccount() &&
        requests.get(requestOwner) === request &&
        now &&
        now.accountId === account &&
        now.controllerScope === scope &&
        window.desktop === bridge,
      );
    };
    const originMatches = () => {
      const now = controller();
      return Boolean(
        now &&
        now.page === origin.page &&
        now.activeId === origin.activeId &&
        now.draftSession === origin.draftSession &&
        now.mode === origin.mode &&
        now.settingsOpen === origin.settingsOpen &&
        window.location?.href === origin.url,
      );
    };
    const atOrigin = () =>
      Boolean(
        sameAccount() &&
        owner.current() &&
        route.current === lease &&
        sourceCurrent?.() !== false &&
        originMatches(),
      );
    try {
      if (typeof bridge.listPlugins !== "function")
        throw new Error(t("Couldn’t load this plugin."));
      const catalog = await bridge.listPlugins();
      if (!atOrigin()) return;
      if (!catalog || !Array.isArray(catalog.plugins))
        throw new Error(t("Couldn’t load this plugin."));
      const matches = catalog.plugins.filter((plugin) => plugin?.id === id);
      if (matches.length !== 1)
        throw new Error(t("That plugin is no longer available."));
      const plugin = matches[0];
      if (plugin.installed !== true || plugin.enabled !== true)
        throw new Error(t("Turn this plugin on to try it"));
      const name =
        (typeof plugin.title === "string" && plugin.title.trim()) ||
        (typeof plugin.name === "string" && plugin.name.trim());
      if (!name) throw new Error(t("Couldn’t load this plugin."));
      const prompt = formatText(pluginChatPrompt, { pluginName: name });
      if (!atOrigin()) return;
      let accepted = false;
      controller()!.newChat("chat", undefined, false, (created) => {
        // No receipt means no new composer: e.g. a forwarded window action,
        // cancelled file transition, or an older independent host.
        if (
          accepted ||
          typeof created?.draftSession !== "string" ||
          !created.draftSession ||
          (created.mode !== "chat" && created.mode !== "cowork") ||
          !sameAccount()
        )
          return;
        const now = controller()!;
        // Own navigation may already have unmounted the initiating leaf.
        // The receipt must refer to this exact new draft, or arrive before
        // React commits newChat's state updates while the origin is current.
        const atCreatedDraft =
          now.page === "chat" &&
          !now.activeId &&
          now.draftSession === created.draftSession &&
          now.mode === created.mode;
        if (!originMatches() && !atCreatedDraft) return;
        accepted = true;
        now.setText(prompt);
        now.setSkillTokens?.([]);
        now.setAttachments([]);
        if (origin.settingsOpen) now.setSettingsOpen(false);
      });
    } catch (error) {
      if (atOrigin()) (report.current ?? controller()!.report)(error);
    }
  };
}
