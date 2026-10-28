import type { Session } from "electron";

type ServiceSession = Pick<
  Session,
  "webRequest" | "isSpellCheckerEnabled" | "setSpellCheckerEnabled"
>;

// Nonessential service destinations.
export function nonessentialService(url: string, platform: NodeJS.Platform) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname;
  return (
    (host === "www.google.com" && parsed.pathname === "/s2/favicons") ||
    (host.endsWith(".gstatic.com") && parsed.pathname === "/faviconV2") ||
    host === "www.claudeusercontent.com" ||
    host.endsWith(".frame.claudeusercontent.com") ||
    host.endsWith(".frame.staging.claudeusercontent.com") ||
    host.endsWith(".claudemcpcontent.com") ||
    (platform === "linux" && host.endsWith(".gvt1.com"))
  );
}

export class NonessentialServices {
  private sessions = new Set<ServiceSession>();
  private spellcheck = new Map<ServiceSession, boolean>();
  private blocked = false;

  constructor(private platform: NodeJS.Platform) {}

  add(session: ServiceSession) {
    if (this.sessions.has(session)) return;
    this.sessions.add(session);
    session.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (details, respond) => {
        respond({
          cancel:
            this.blocked && nonessentialService(details.url, this.platform),
        });
      },
    );
    this.applySpellcheck(session);
  }

  update(blocked: boolean) {
    this.blocked = blocked;
    for (const session of this.sessions) this.applySpellcheck(session);
  }

  private applySpellcheck(session: ServiceSession) {
    if (this.platform !== "linux") return;
    if (this.blocked) {
      if (!this.spellcheck.has(session))
        this.spellcheck.set(session, session.isSpellCheckerEnabled());
      session.setSpellCheckerEnabled(false);
    } else if (this.spellcheck.has(session)) {
      session.setSpellCheckerEnabled(this.spellcheck.get(session)!);
      this.spellcheck.delete(session);
    }
  }
}
