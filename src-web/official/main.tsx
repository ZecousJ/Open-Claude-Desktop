import { createRoot } from "react-dom/client";
import { createWebBridge } from "../bridge";
import { browserEnv } from "../bridge/browser-env";
import { Toaster } from "../../src/ui/Toaster";
import { dismissToast, showToast } from "../../src/ui/toast-store";
import { AuthGate } from "../../src/app/AuthGate";
import { BootErrorPage } from "../../src/boot/BootErrorPage";
import { initialLocale, setLocale, t } from "../../src/i18n";
import { showDispatchNotification } from "../../src/dispatch/notifications";
import { OfficialWebSurface } from "./OfficialWebSurface";
import { OfficialShareLink } from "./OfficialShareLink";
import { officialDesignWorkspacePath } from "../../shared/official-design-artifacts";
import { officialShareId } from "../../shared/official-share-link";
import "../../src/styles.css";
import "../../src/ui/menu.css";
import "../../src/ui/anthropicon.css";
import "../../src/ui/sheet.css";
import "../../src/boot/boot.css";
import "../../src/styles/95-web.css";
import "./host.css";
const gallery = officialDesignWorkspacePath(location.pathname);
if (gallery) history.replaceState(null, "", gallery);
const dispatchPath = "/cowork/agent";
const dispatchToasts = new Set<number>();
const dispatchNotices = new Set<Notification>();
const bridge = createWebBridge(browserEnv(), {
  prefetchSnapshot: false,
  dispatchNotice(deviceId, event, current) {
    const url = `${dispatchPath}?${new URLSearchParams({ device: deviceId, task: event.conversationId })}`;
    const id = showToast(t(event.body), {
      description: event.title,
      action: {
        label: t("View task"),
        onSelect: () => {
          if (current()) location.assign(url);
        },
      },
      onDismiss: () => {
        dispatchToasts.delete(id);
      },
    });
    dispatchToasts.add(id);
    const notice = showDispatchNotification(deviceId, event, {
      path: dispatchPath,
      current,
    });
    if (notice) {
      dispatchNotices.add(notice);
      notice.onclose = () => dispatchNotices.delete(notice);
    }
  },
});
let dispatchActivation: object | undefined;
function clearDispatchNotices() {
  for (const notice of dispatchNotices) notice.close();
  for (const id of dispatchToasts) dismissToast(id);
  dispatchNotices.clear();
  dispatchToasts.clear();
}
bridge.auth.onChange(() => {
  const activation = bridge.auth.activationIdentity;
  if (activation === dispatchActivation) return;
  dispatchActivation = activation;
  clearDispatchNotices();
});
function subscribeAccountSwitch(listener: () => void) {
  let previous = bridge.auth.current?.account.id;
  return bridge.auth.onChange((session) => {
    const current = session?.account.id;
    const switched = current !== undefined && previous !== undefined && current !== previous;
    const adding = previous !== undefined && current === undefined && bridge.auth.addingAccount() !== undefined;
    previous = current;
    if (switched || adding) {
      history.replaceState(null, "", adding ? "/login" : "/new");
      listener();
    }
  });
}
Object.defineProperty(window, "desktop", {
  value: bridge.api,
  writable: false,
  configurable: false,
});
window.addEventListener("pagehide", () => {
  bridge.dispose();
  clearDispatchNotices();
}, { once: true });
document.documentElement.dataset.surface = "web";
void bridge.api.authStatus().then((status) => {
  if (status.account || bridge.auth.current) return;
  delete document.documentElement.dataset.officialWorkspace;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.officialHomeBoot;
}).catch(() => {});
void setLocale(initialLocale())
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <AuthGate
        startWithPendingPolicy
        subscribeAccountSwitch={subscribeAccountSwitch}
        renderApp={(props) => {
          const shareId = officialShareId(new URL(location.href), location.origin, true);
          const surface = (
            <>
              <Toaster />
              <OfficialWebSurface
                {...props}
                bridge={bridge}
                chatActionMode="engine-chat"
                memoryControlsOptIn={
                  import.meta.env.VITE_CLAUDEX_OFFICIAL_MEMORY_CONTROLS === "1"
                }
                appearanceSettingsOptIn={
                  import.meta.env.VITE_CLAUDEX_OFFICIAL_APPEARANCE_SETTINGS ===
                  "1"
                }
                userContentOrigin={
                  import.meta.env.VITE_CLAUDEX_OFFICIAL_USERCONTENT_ORIGIN
                }
              />
            </>
          );
          return shareId ? (
            <OfficialShareLink
              bridge={bridge}
              accountId={props.accountId}
              shareId={shareId}
            >
              {surface}
            </OfficialShareLink>
          ) : (
            surface
          );
        }}
      />,
    );
  })
  .catch((error) => {
    delete document.documentElement.dataset.officialHomeBoot;
    createRoot(document.getElementById("root")!).render(
      <BootErrorPage error={error} />,
    );
  });
