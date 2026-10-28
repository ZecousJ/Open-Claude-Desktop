import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

/**
 * The desktop's Continue with Google (LOGIN-GOOGLE): Google's authorization
 * for the desktop client runs in the person's browser with PKCE; Google
 * sends the browser back to a one-time address on this computer
 * (127.0.0.1, a free port) with a code, which the service exchanges for the
 * person's account (it alone holds the client's secret). The page left in
 * the browser says to go back to Claudex.
 */
export interface GoogleAuthorization {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

const authorizeUrl = "https://accounts.google.com/o/oauth2/v2/auth";
/** How long the browser has to come back. */
const waitMs = 5 * 60_000;

const base64url = (bytes: Buffer) =>
  bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;font:15px/1.5 -apple-system,"Segoe UI",sans-serif;background:#1f1e1d;color:#f0efec}main{max-width:360px;padding:24px;text-align:center}h1{font-size:18px;font-weight:600;margin:0 0 8px}p{margin:0;color:#c3c2b7}@media (prefers-color-scheme:light){body{background:#faf9f5;color:#0b0b0b}p{color:#52514e}}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

let pending: { cancel: () => void } | undefined;

/** Cancels a Google sign-in that is waiting for the browser. */
export function cancelGoogleAuthorization() {
  pending?.cancel();
}

/** Opens Google in the browser and waits for its code. */
export function authorizeWithGoogle(
  clientId: string,
  open: (url: string) => Promise<void> = async (url) =>
    (await import("electron")).shell.openExternal(url),
): Promise<GoogleAuthorization> {
  pending?.cancel();
  const codeVerifier = base64url(randomBytes(48));
  const challenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );
  const state = base64url(randomBytes(24));
  return new Promise<GoogleAuthorization>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const matches = url.searchParams.get("state") === state;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      if (!matches) {
        res.end(page("Sign-in didn’t match", "Start again from Claudex."));
        return;
      }
      if (code) {
        res.end(
          page(
            "You’re signed in",
            "You can close this tab and go back to Claudex.",
          ),
        );
        finish(() => resolve({ code, codeVerifier, redirectUri }));
      } else {
        res.end(
          page(
            "Sign-in was cancelled",
            "You can close this tab and go back to Claudex.",
          ),
        );
        finish(() =>
          reject(
            Error(
              error === "access_denied"
                ? "Google sign-in was cancelled."
                : "Google didn’t finish signing you in. Try again.",
            ),
          ),
        );
      }
    });
    let redirectUri = "";
    const finish = (then: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending = undefined;
      // Let the page reach the browser before the server goes.
      setTimeout(() => server.close(), 500);
      then();
    };
    pending = {
      cancel: () =>
        finish(() => reject(Error("Google sign-in was cancelled."))),
    };
    server.on("error", () =>
      finish(() =>
        reject(Error("Claudex couldn’t wait for Google here. Try again.")),
      ),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return finish(() =>
          reject(Error("Claudex couldn’t wait for Google here. Try again.")),
        );
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const url = new URL(authorizeUrl);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        prompt: "select_account",
      }).toString();
      timer = setTimeout(
        () =>
          finish(() => reject(Error("Google sign-in timed out. Try again."))),
        waitMs,
      );
      open(url.toString()).catch(() =>
        finish(() => reject(Error("Claudex couldn’t open your browser."))),
      );
    });
  });
}
