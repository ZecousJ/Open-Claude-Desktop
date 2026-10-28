/**
 * The first-run onboarding, a window-level overlay. Loaded by src/main.tsx
 * before the first render: it only asks the service whether this account
 * still has the onboarding to do; the steps and their stylesheet load when
 * it does, so nothing here weighs on the first load.
 *
 * The profile step of sign-up hands over to it: once the account is signed
 * in and the window opens, a new account (pending on the service) sees it,
 * and no one else ever does.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import { registerOverlay } from "../app/AppOverlays";
import { useApp } from "../app/AppContext";
import { api } from "../desktop-api";
import { lazyPiece } from "../ui/lazy-piece";
import { useHost } from "../host/HostContext";
import { homeMode } from "../home/home-mode";
import type { OnboardingExit } from "./OnboardingFlow";
import {
  noOnboarding,
  type OnboardingState,
} from "../../shared/onboarding-api";
import { normalizeWorkType } from "../../shared/settings-extras";

const OnboardingFlow = lazyPiece(() => import("./OnboardingFlow"));

function OnboardingOverlay() {
  const app = useApp();
  const host = useHost();
  const [state, setState] = useState<OnboardingState>();
  const latest = useRef(app);
  latest.current = app;
  const { accountId, remoteAccount } = app;
  const main = app.windowRole.kind === "main";
  useEffect(() => {
    setState(undefined);
    if (!accountId || !remoteAccount || !main) return;
    let live = true;
    Promise.resolve()
      .then(() => api.onboardingState())
      .then(
        (next) => live && setState(next),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [accountId, remoteAccount, main]);
  if (!state?.pending) return null;
  const finish = (exit: OnboardingExit) => {
    setState(noOnboarding);
    const current = latest.current;
    current.newChat(exit.mode === "code" ? "code" : homeMode("chat", host));
    // The new chat's draft is restored first; the starter task goes in after.
    if (exit.prompt) {
      const prompt = exit.prompt;
      setTimeout(() => {
        latest.current.setText(prompt);
        latest.current.composer.current?.focus();
      }, 60);
    }
  };
  return (
    // Browse all connectors opens Settings, drawn under the overlays: the
    // onboarding steps aside (kept as it is) until Settings closes.
    <div hidden={app.settingsOpen}>
      <Suspense fallback={null}>
        <OnboardingFlow
          accountId={accountId}
          initial={state}
          workType={normalizeWorkType(app.snapshot.settings.workType)}
          onWorkType={(workType) =>
            void app.updatePreference({ workType }).catch(app.report)
          }
          onOpenConnectors={() => app.openSettingsTab("connectors")}
          onOpenSystem={() => app.openSettingsTab("system")}
          platform={app.snapshot.platform}
          onFinish={finish}
        />
      </Suspense>
    </div>
  );
}

registerOverlay("onboarding", OnboardingOverlay);
