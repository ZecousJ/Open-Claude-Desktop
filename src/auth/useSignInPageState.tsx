import type { BrowserAccount } from "../../shared/sign-in-api";
import { needsSignInAgain } from "../../shared/sign-in-api";
import {
  web,
  keepEmailLink,
  rememberLoginMethod,
  pendingEmailLink,
} from "./signin-env";
import type {
  PublicAccount,
  TwoFactorChallenge,
  AuthStatus,
  RemoteSignInPolicy,
} from "../../shared/types";
import { emailLinkRequest, parseEmailLink } from "../../shared/email-link";
import { useEffect } from "react";
import type { EmailLink, EmailLinkRequest } from "../../shared/email-link";
import { useSignInPageActions } from "./useSignInPageActions";
import type { AuthStep, StatePage } from "./signInView";
import type { OfflineWait } from "./whenOnline";
import type { SignInValues } from "./SignInSteps";

/** What useSignInPageState needs from SignInPage.tsx. */
export interface UseSignInPageStateKit {
  accounts: BrowserAccount[];
  adding: { email?: string | undefined } | undefined;
  addingFor: BrowserAccount | undefined;
  busy: boolean;
  callbackActive: React.RefObject<boolean>;
  callbackHandled: React.RefObject<boolean>;
  callbackLink: EmailLink | undefined;
  confirm: string;
  countdown: number;
  email: string;
  error: string;
  fail: (reason: unknown) => void;
  focus: React.RefObject<HTMLInputElement | null>;
  go: (next: AuthStep) => void;
  linkBusy: React.RefObject<boolean>;
  linkFallback: EmailLink | undefined;
  linkRequest: React.RefObject<EmailLinkRequest | undefined>;
  offline: OfflineWait | undefined;
  onRetry: () => void;
  onSignedIn: (account: PublicAccount) => void;
  policy: RemoteSignInPolicy | undefined;
  resetLink: { email: string; token: string } | undefined;
  run: (
    task: () => Promise<void>,
    wait?: OfflineWait | undefined,
  ) => Promise<void>;
  sent: string;
  set: (field: keyof SignInValues, value: string) => void;
  setAccounts: React.Dispatch<React.SetStateAction<BrowserAccount[]>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setChoosing: React.Dispatch<React.SetStateAction<boolean>>;
  setCodeAutoFocus: React.Dispatch<React.SetStateAction<boolean>>;
  setCountdown: React.Dispatch<React.SetStateAction<number>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  setLinkFallback: React.Dispatch<React.SetStateAction<EmailLink | undefined>>;
  setMaskedEmail: React.Dispatch<React.SetStateAction<string>>;
  setSent: React.Dispatch<React.SetStateAction<string>>;
  setShowNotice: React.Dispatch<React.SetStateAction<boolean>>;
  setState: React.Dispatch<React.SetStateAction<StatePage | undefined>>;
  setStep: React.Dispatch<React.SetStateAction<AuthStep>>;
  setValues: React.Dispatch<React.SetStateAction<SignInValues>>;
  setWelcoming: React.Dispatch<React.SetStateAction<boolean>>;
  state: StatePage | undefined;
  status: AuthStatus;
  step: AuthStep;
  values: SignInValues;
}

export function useSignInPageState(kit: UseSignInPageStateKit) {
  const {
    accounts,
    adding,
    addingFor,
    busy,
    callbackActive,
    callbackHandled,
    callbackLink,
    confirm,
    countdown,
    email,
    error,
    fail,
    focus,
    go,
    linkBusy,
    linkFallback,
    linkRequest,
    offline,
    onRetry,
    onSignedIn,
    policy,
    resetLink,
    run,
    sent,
    set,
    setAccounts,
    setBusy,
    setChoosing,
    setCodeAutoFocus,
    setCountdown,
    setError,
    setLinkFallback,
    setMaskedEmail,
    setSent,
    setShowNotice,
    setState,
    setStep,
    setValues,
    setWelcoming,
    state,
    status,
    step,
    values,
  } = kit;
  /** A remembered account: signed in here, it opens; otherwise its form. */
  function pick(account: BrowserAccount) {
    setShowNotice(false);
    const fill = () => {
      setValues((current) => ({ ...current, email: account.email }));
      setChoosing(false);
    };
    if (!account.signedIn) {
      fill();
      return;
    }
    void run(async () => {
      try {
        onSignedIn(await window.desktop.switchAccount(account.id));
      } catch (reason) {
        // Its session ended since: sign in to it again.
        if (!needsSignInAgain(reason)) throw reason;
        setAccounts((list) =>
          list.map((item) =>
            item.id === account.id ? { ...item, signedIn: false } : item,
          ),
        );
        fill();
      }
    }, "sign-in");
  }
  function forget(account: BrowserAccount) {
    void run(async () => {
      await window.desktop.forgetBrowserAccount(account.id);
      const rest = accounts.filter((item) => item.id !== account.id);
      setAccounts(rest);
      if (values.email === account.email) set("email", "");
      if (!rest.length) setChoosing(false);
    });
  }
  /** Adding an account: back to the one that stayed signed in. */
  function backToAccount() {
    void run(async () => {
      await window.desktop.cancelAddAccount();
      // The desktop's window has no addresses.
      if (web) history.replaceState(null, "", "/new");
      onRetry();
    });
  }
  function signedIn(result: PublicAccount | TwoFactorChallenge) {
    if (web && callbackLink) history.replaceState(null, "", "/new");
    setLinkFallback(undefined);
    linkRequest.current = undefined;
    keepEmailLink();
    if ("twoFactorRequired" in result) {
      setMaskedEmail(result.maskedEmail);
      go("twoFactor");
    } else onSignedIn(result);
  }
  async function sendCode(kind: "sign-in" | "register") {
    const request = kind === "sign-in" ? emailLinkRequest(!web) : undefined;
    const { countdown } =
      kind === "sign-in"
        ? await window.desktop.sendSignInCode(email, request)
        : await window.desktop.sendVerificationCode(email);
    if (request) {
      linkRequest.current = request;
      keepEmailLink({ ...request, email, expiresAt: Date.now() + 600_000 });
    }
    setCountdown(countdown || 60);
  }
  useEffect(() => {
    // .
    let channel: BroadcastChannel | undefined;
    async function complete(link: EmailLink) {
      const request = linkRequest.current;
      if (
        !request ||
        request.request_id !== link.request_id ||
        email.toLowerCase() !== link.email.toLowerCase()
      ) {
        if (!web) {
          setWelcoming(false);
          setLinkFallback(link);
        }
        return;
      }
      if (linkBusy.current) return;
      linkBusy.current = true;
      setBusy(true);
      try {
        const result = await window.desktop.loginWithCode(
          link.email,
          link.code,
          request,
        );
        rememberLoginMethod("email");
        keepEmailLink();
        if (!("twoFactorRequired" in result))
          channel?.postMessage({ completed: link.request_id });
        signedIn(result);
      } catch (reason) {
        fail(reason);
      } finally {
        linkBusy.current = false;
        setBusy(false);
      }
    }
    const unsubscribe = window.desktop.onEvent((event) => {
      if (event.type === "email-sign-in-link") void complete(event.link);
    });
    if (web) {
      channel = new BroadcastChannel("claudex-email-link");
      channel.onmessage = (event) => {
        if (
          callbackActive.current &&
          typeof event.data?.completed === "string" &&
          event.data.completed ===
            (callbackLink?.request_id ?? linkRequest.current?.request_id)
        ) {
          history.replaceState(null, "", "/new");
          onRetry();
          return;
        }
        const link =
          typeof event.data === "string"
            ? parseEmailLink(event.data)
            : undefined;
        if (link) void complete(link);
      };
      if (callbackLink && !callbackHandled.current) {
        callbackHandled.current = true;
        history.replaceState(null, "", "/sign-in/callback");
        let restored = false;
        try {
          const saved = pendingEmailLink();
          if (
            !status.account &&
            saved?.request_id === callbackLink.request_id &&
            saved.email.toLowerCase() === callbackLink.email.toLowerCase()
          ) {
            linkRequest.current = {
              request_id: saved.request_id,
              request_secret: saved.request_secret,
              desktop: false,
            };
            restored = true;
            void complete(callbackLink);
          }
        } catch {}
        if (!restored)
          channel.postMessage(
            location.origin +
              "/sign-in/callback#" +
              new URLSearchParams({ ...callbackLink }),
          );
      }
    } else if (callbackLink) {
      const params = new URLSearchParams(location.search);
      params.delete("email-link");
      history.replaceState(
        null,
        "",
        location.pathname + (params.size ? "?" + params : ""),
      );
    }
    return () => {
      unsubscribe();
      channel?.close();
    };
  }, [email, callbackLink]);
  const {
    page,
    changeEmail,
    codeIncomplete,
    feedback,
    google,
    input,
    passkey,
    primary,
    resend,
    stateAction,
    submit,
    title,
    subtitle,
  } = useSignInPageActions({
    adding,
    addingFor,
    busy,
    confirm,
    countdown,
    email,
    error,
    focus,
    go,
    linkFallback,
    offline,
    onRetry,
    onSignedIn,
    policy,
    resetLink,
    run,
    sendCode,
    sent,
    set,
    setCodeAutoFocus,
    setError,
    setSent,
    setShowNotice,
    setState,
    setStep,
    setValues,
    signedIn,
    state,
    status,
    step,
    values,
  });
  return {
    page,
    changeEmail,
    codeIncomplete,
    feedback,
    forget,
    google,
    input,
    passkey,
    pick,
    primary,
    resend,
    sendCode,
    stateAction,
    submit,
    title,
    subtitle,
    backToAccount,
  } as const;
}
