import { Suspense } from "react";
import { useHost } from "../host/HostContext";
import { useApp } from "./AppContext";
import { lazyPiece } from "../ui/lazy-piece";
import { useSettingsSkillsNavigation } from "../settings/skills-navigation";

// The Settings window and its pages load when it is first opened, off the
// web build's first load.
const Settings = lazyPiece(
  () => import("../settings/SettingsDialog"),
  "Settings",
);

/**
 * The Settings window over the app.
 *
 * On the web the address is /settings/<tab> while it is open
 * (W-UI-design §6.1): the route opens it with `openSettingsTab(tab)`, and
 * the page shown is written back to `app.settingsTab`, so `settingsOpen`
 * and `settingsTab` always describe the address. A tab the route names
 * while Settings is open (back, forward) switches the page. On the
 * desktop `settingsTab` stays the page Settings was last opened on.
 */
export function SettingsOverlay() {
  const app = useApp();
  const web = useHost().kind === "web";
  const { snapshot } = app;
  const skills = useSettingsSkillsNavigation(app.accountId, app.settingsOpen);
  if (!app.settingsOpen) return null;
  return (
    <Suspense fallback={null}>
      <Settings
        settings={snapshot.settings}
        initialTab={app.settingsTab}
        skillsView={skills.view}
        skillsViewKey={skills.pageKey}
        skillsViewRequestId={skills.requestId}
        onSkillsViewChange={skills.onViewChange}
        onTabChange={
          web
            ? (tab) => {
                if (tab !== app.settingsTab) app.openSettingsTab(tab);
              }
            : undefined
        }
        platform={snapshot.platform as NodeJS.Platform}
        engine={snapshot.engine}
        email={app.accountEmail}
        planUsage={app.remoteAccount}
        onSignOut={app.onSignOut}
        onSignOutEverywhere={app.onSignOutEverywhere}
        onClose={() => app.setSettingsOpen(false)}
        onSave={(settings) => {
          // Settings save on every change; keep the chosen model
          // unless the service's provider itself changed.
          if (settings.activeProviderId !== app.providerId) {
            app.setProviderId(settings.activeProviderId);
            app.setModel(
              settings.providers.find((p) => p.id === settings.activeProviderId)
                ?.model ?? "",
            );
          }
          app.setSnapshot((s) => (s ? { ...s, settings } : s));
        }}
        onError={app.report}
      />
    </Suspense>
  );
}
