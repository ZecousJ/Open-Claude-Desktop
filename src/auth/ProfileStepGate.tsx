import { Suspense, useEffect, useState, type ReactNode } from "react";
import { surface } from "../../shared/host";
import type { SignUpProfile } from "../../shared/account-profile-api";
import { WebBoot } from "../boot/BootShell";
import { lazyPiece } from "../ui/lazy-piece";
import { rememberTerms, rememberedTerms } from "./profile-step-form";

/** The step's page and styles load only when an account needs it. */
const ProfileStep = lazyPiece(() => import("./ProfileStep"), "ProfileStep");

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The account step after sign-up stands before the app, as the original's
 * onboarding gate does: an account of a Claudex service whose name, birthday or
 * current terms are not on record sees ProfileStep first. A device that saw the
 * account finish opens the app at once and asks the service in the background
 * (a new terms version brings the step back); otherwise the app waits for the
 * answer. A service without the step, or one that cannot answer, lets the
 * account in: the step is asked again at the next start.
 */
export function ProfileStepGate({
  accountId,
  email,
  remote,
  onSignOut,
  children,
}: {
  accountId: string;
  email: string;
  /** Local accounts have no service to keep the step. */
  remote: boolean;
  onSignOut: () => Promise<void>;
  children: ReactNode;
}) {
  const [known] = useState(
    () => !remote || Boolean(rememberedTerms(storage(), accountId)),
  );
  const [state, setState] = useState<
    | { kind: "checking" }
    | { kind: "done" }
    | { kind: "step"; profile: SignUpProfile }
  >(known ? { kind: "done" } : { kind: "checking" });
  useEffect(() => {
    if (!remote) return;
    let live = true;
    window.desktop
      .signUpProfile()
      .then((profile) => {
        if (!live) return;
        if (!profile || profile.complete) {
          if (profile)
            rememberTerms(storage(), accountId, profile.currentTermsVersion);
          setState({ kind: "done" });
        } else setState({ kind: "step", profile });
      })
      .catch(() => live && setState({ kind: "done" }));
    return () => {
      live = false;
    };
  }, [accountId, remote]);
  if (state.kind === "done") return <>{children}</>;
  if (state.kind === "checking") return surface === "web" ? <WebBoot /> : null;
  return (
    <Suspense fallback={null}>
      <ProfileStep
        profile={state.profile}
        email={email}
        onDone={async (saved) => {
          rememberTerms(storage(), accountId, saved.currentTermsVersion);
          // The name is also what Settings → "What should Claudex call
          // you?" holds (the original's display_name), when it is empty;
          // saved before the app reads its settings.
          try {
            const { settings } = await window.desktop.snapshot();
            if (!settings.name.trim())
              await window.desktop.saveSettings({
                ...settings,
                name: saved.displayName,
              });
          } catch {
            /* The step is saved; the setting stays as it was. */
          }
          setState({ kind: "done" });
        }}
        onUseDifferentEmail={() => void onSignOut().catch(() => {})}
      />
    </Suspense>
  );
}
