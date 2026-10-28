import { useEffect, useRef, useState } from "react";
import { surface } from "../../shared/host";

/**
 * Continue with Google (LOGIN-GOOGLE), as the live claude.ai login page draws
 * it: a large secondary button the card's width with Google's "G". On the
 * desktop the main process opens Google in the browser. On the web the click
 * runs Google Identity Services' code client in a popup (prepared on mount,
 * since the popup must open in the click) and hands the page the code for the
 * service to exchange; if Google's script can't load (Google unreachable)
 * nothing shows.
 */

type CodeClient = { requestCode(): void };
type GoogleOAuth = {
  initCodeClient(options: {
    client_id: string;
    scope: string;
    ux_mode: "popup";
    callback: (response: { code?: string; error?: string }) => void;
    error_callback?: (error: { type?: string }) => void;
  }): CodeClient;
};
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth } };
  }
}

const scriptUrl = "https://accounts.google.com/gsi/client";
let loading: Promise<GoogleOAuth> | undefined;

function loadGoogleOAuth(): Promise<GoogleOAuth> {
  loading ??= new Promise<GoogleOAuth>((resolve, reject) => {
    const ready = () => {
      const id = window.google?.accounts?.oauth2;
      if (id) resolve(id);
      else reject(Error("Google sign-in did not load."));
    };
    if (window.google?.accounts?.oauth2) return ready();
    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;
    script.onload = ready;
    script.onerror = () => {
      loading = undefined;
      reject(Error("Google sign-in did not load."));
    };
    document.head.append(script);
  });
  return loading;
}

/** Google's "G". */
export function GoogleMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <g transform="translate(1.575 2) scale(1.25)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16.18 8.1818C16.18 7.61453 16.1291 7.06908 16.0345 6.54544H8.5V9.63999H12.8055C12.62 10.64 12.0564 11.4873 11.2091 12.0545V14.0618H13.7945C15.3073 12.6691 16.18 10.6182 16.18 8.1818Z"
          fill="#4285F4"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8.49992 16C10.6599 16 12.4708 15.2836 13.7945 14.0618L11.209 12.0545C10.4926 12.5345 9.57629 12.8182 8.49992 12.8182C6.41629 12.8182 4.65265 11.4109 4.02356 9.51999H1.35083V11.5927C2.66719 14.2073 5.37265 16 8.49992 16Z"
          fill="#34A853"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M4.02364 9.52001C3.86364 9.04001 3.77273 8.52729 3.77273 8.00001C3.77273 7.47274 3.86364 6.96001 4.02364 6.48001V4.40729H1.35091C0.809091 5.48729 0.5 6.70911 0.5 8.00001C0.5 9.29092 0.809091 10.5127 1.35091 11.5927L4.02364 9.52001Z"
          fill="#FBBC05"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8.49992 3.18182C9.67447 3.18182 10.729 3.58545 11.5581 4.37818L13.8526 2.08364C12.4672 0.792727 10.6563 0 8.49992 0C5.37265 0 2.66719 1.79273 1.35083 4.40727L4.02356 6.48C4.65265 4.58909 6.41629 3.18182 8.49992 3.18182Z"
          fill="#EA4335"
        />
      </g>
    </svg>
  );
}

export function GoogleSignInButton({
  clientId,
  disabled,
  onDesktop,
  onCode,
}: {
  clientId: string;
  disabled?: boolean;
  /** Desktop: starts the browser sign-in. */
  onDesktop: () => void;
  /** Web: the authorization code Google's popup gave. */
  onCode: (code: string) => void;
}) {
  const client = useRef<CodeClient | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(onCode);
  latest.current = onCode;
  useEffect(() => {
    if (surface !== "web") return;
    let live = true;
    loadGoogleOAuth()
      .then((oauth) => {
        if (!live) return;
        client.current = oauth.initCodeClient({
          client_id: clientId,
          scope: "openid profile email",
          ux_mode: "popup",
          callback: (response) => {
            if (response.code) latest.current(response.code);
          },
        });
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [clientId]);

  if (failed) return null;
  return (
    <button
      type="button"
      className="signin-secondary signin-wide signin-google"
      disabled={disabled}
      onClick={() =>
        surface === "web" ? client.current?.requestCode() : onDesktop()
      }
    >
      <GoogleMark />
      <span>Continue with Google</span>
    </button>
  );
}
