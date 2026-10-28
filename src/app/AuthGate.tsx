import {
  Component,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { surface } from "../../shared/host";
import { configureHelpOrigin } from "../../shared/help-links";
import type { AuthStatus } from "../../shared/types";
import { App } from "./App";
import { signedOutNotice, type SignedOutNotice } from "../auth/signedOut";
import { resetLinkOf, startModeOf } from "../auth/startMode";
import { PolicyProvider } from "../policy/PolicyContext";
import { AnnouncementsProvider } from "../policy/Announcements";
import { productName } from "../web/document-title";
import { parseWebRoute } from "../web/routes";
import { WebBoot } from "../boot/BootShell";
import { BootErrorPage, FramelessControls } from "../boot/BootErrorPage";
import { PageErrorBanner } from "./PageBoundary";
import { writeBootHints } from "../boot/boot-hints";
import { forgetAccountDrafts } from "../composer/draft-store";
import { forgetAccountLocalData } from "./forget-account-data";
import { ProfileStepGate } from "../auth/ProfileStepGate";
import "../web/web-shell.css";
import { lazyPiece } from "../ui/lazy-piece";
import { Toaster } from "../ui/Toaster";

const web = surface === "web";

/**
 * The signed-out pages and their stylesheet load on demand: a signed-in start
 * never fetches them, which keeps them out of the web app's first-load budget
 * (scripts/check-web-bundle.mjs).
 */
const SignInPage = lazyPiece(() => import("../auth/SignInPage"));

/** The web app's sign-in page title (W-UI-design §6.2). */
export const signInTitle = `Sign in - ${productName}`;

const ResetPasswordPage = lazyPiece(
  () => import("../auth/ResetPasswordPage"),
  "ResetPasswordPage",
);
/**
 * A rendering error anywhere in the window: the original's page boundary for a
 * page that cannot render, its danger banner "Something went wrong loading this
 * page." with Reload. It is in the first-load bundle, so it shows even when
 * nothing more can be fetched (offline, or a deploy removed the scripts this
 * page names); the signed-out pages' error page loaded on demand and left a
 * blank window then.
 */
class WindowBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("The window failed to render:", error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="window-error">
        <FramelessControls />
        <PageErrorBanner
          message="Something went wrong loading this page."
          action="Reload"
          onAction={() => location.reload()}
        />
      </div>
    );
  }
}

export function AuthGate() {
  return (
    <WindowBoundary>
      <Gate />
    </WindowBoundary>
  );
}

function Gate() {
  const [status, setStatus] = useState<AuthStatus>();
  // Why the account could not be read; the boot error page says so.
  const [error, setError] = useState<{ reason: unknown }>();
  // Remounts the form after sign-out so it starts from the new status.
  const [formKey, setFormKey] = useState(0);
  // Why the service ended the session, shown on the sign-in card until the next sign-in.
  const [notice, setNotice] = useState<SignedOutNotice>();
  const cancelLoad = useRef<(() => void) | undefined>(undefined);
  function load() {
    cancelLoad.current?.();
    let live = true;
    setError(undefined);
    void window.desktop
      .authStatus()
      .then((value) => {
        if (live) {
          configureHelpOrigin(value.serviceOrigin);
          if (web) writeBootHints({ signedIn: Boolean(value.account) });
          setStatus(value);
          setFormKey((key) => key + 1);
        }
      })
      .catch((reason) => {
        if (live) setError({ reason });
      });
    cancelLoad.current = () => {
      live = false;
    };
    return cancelLoad.current;
  }
  useEffect(load, []);
  // The main process ended this device's session (all devices signed out,
  // this device removed, or the session expired): back to the sign-in card.
  useEffect(
    () =>
      window.desktop.onEvent?.((event) => {
        if (event.type !== "signed-out") return;
        setNotice(signedOutNotice(event));
        load();
      }),
    [],
  );
  const signedIn = Boolean(status?.account);
  // The account signed in last on this page: someone else signing in does not
  // open its conversation or project address.
  const lastAccount = useRef<string | undefined>(undefined);
  if (status?.account) lastAccount.current = status.account.id;
  // The emailed reset link, kept while its page shows: signed in (maybe as
  // someone else) the link still sets the new password before the app shows.
  const [resetLink, setResetLink] = useState(() =>
    web && startModeOf(location.pathname, location.search) === "reset"
      ? resetLinkOf(location.search)
      : undefined,
  );
  // Signed in, the app titles the tab (src/web/document-title.ts). While the
  // session is still being restored the tab keeps its title: it is not the
  // sign-in page yet.
  useEffect(() => {
    if (web && status && !signedIn) document.title = signInTitle;
  }, [signedIn, status]);
  const signedOut = (next: AuthStatus) => {
    if (web) writeBootHints({ signedIn: Boolean(next.account) });
    // Signing out leaves the account's address for the sign-in page's.
    if (web && !next.account) history.replaceState(null, "", "/login");
    setNotice(undefined);
    setStatus(next);
    setFormKey((key) => key + 1);
  };
  if (web && status?.account && location.pathname === "/sign-in/callback")
    return (
      <Suspense fallback={web ? <WebBoot /> : null}>
        <SignInPage
          status={status}
          onSignedIn={(account) => {
            history.replaceState(null, "", "/new");
            setStatus({ ...status, account });
          }}
          onRetry={load}
        />
      </Suspense>
    );
  if (status?.account && resetLink)
    return (
      <Suspense fallback={web ? <WebBoot /> : null}>
        <ResetPasswordPage
          link={resetLink}
          signedInEmail={status.account.email}
          minLength={status.remote ? 6 : 12}
          onDone={() => {
            history.replaceState(history.state, "", "/new");
            setResetLink(undefined);
          }}
        />
      </Suspense>
    );
  if (status?.account) {
    // Signing out forgets the account's unsent drafts and its choices kept on
    // this device.
    const signOut = async () => {
      const next = await window.desktop.logoutAccount();
      forgetAccountDrafts(status.account!.id);
      forgetAccountLocalData();
      signedOut(next);
    };
    return (
      <ProfileStepGate
        key={status.account.id}
        accountId={status.account.id}
        email={status.account.email}
        remote={Boolean(status.account.remote)}
        onSignOut={signOut}
      >
        <PolicyProvider key={status.account.id}>
          <AnnouncementsProvider>
            <App
              accountId={status.account.id}
              accountEmail={status.account.email}
              accountPlan={status.account.plan}
              remoteAccount={Boolean(status.account.remote)}
              legacyArtifactOwner={Boolean(status.account.legacyArtifactOwner)}
              onSignOut={signOut}
              onSignOutEverywhere={
                status.account.remote
                  ? async () => {
                      const next = await window.desktop.revokeAllSessions();
                      forgetAccountDrafts(status.account!.id);
                      forgetAccountLocalData();
                      signedOut(next);
                    }
                  : undefined
              }
            />
          </AnnouncementsProvider>
        </PolicyProvider>
      </ProfileStepGate>
    );
  }
  // Keep the themed background until authentication has resolved.
  if (web && !status && !error) return <WebBoot />;
  // The account could not be read: the original's boot error page, Log out
  // included while the service is down.
  if (!status && error)
    return (
      <BootErrorPage
        error={error.reason}
        answered={!web}
        onLogOut={() =>
          void window.desktop
            .logoutAccount()
            .then(signedOut)
            .catch(() => location.reload())
        }
      />
    );
  return (
    <>
      <Toaster />
      <Suspense fallback={web ? <WebBoot /> : null}>
        <SignInPage
          key={formKey}
          status={status}
          notice={notice}
          startMode={
            web ? startModeOf(location.pathname, location.search) : undefined
          }
          resetLink={
            web && startModeOf(location.pathname, location.search) === "reset"
              ? resetLinkOf(location.search)
              : undefined
          }
          onSignedIn={(account) => {
            if (web) writeBootHints({ signedIn: true });
            const kind = parseWebRoute(location.pathname, location.search).kind;
            if (
              web &&
              lastAccount.current &&
              lastAccount.current !== account.id &&
              (kind === "chat" || kind === "code-chat" || kind === "project")
            )
              history.replaceState(null, "", "/new");
            setNotice(undefined);
            if (status) setStatus({ ...status, account });
          }}
          onRetry={load}
        />
      </Suspense>
    </>
  );
}
