import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArtifactShareInfo, ArtifactShareInput } from "../../shared/types";

interface Entry extends ArtifactShareInfo {
  token?: string;
  title: string;
  language: string;
  content: string;
}

const documentCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts";
/** The page around the snapshot runs one inline script: the one carrying this response's nonce. */
export function sharePageCsp(nonce: string) {
  return `default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`;
}
/** What the page says under no chrome of its own, as the reference's plain header does. */
export const shareByline = "Content is user-generated and unverified.";
/**
 * The page a local link opens: a bar with the artifact's title, then the
 * snapshot in a sandboxed frame. It follows the artifact viewer's own shell in
 * the form it takes without its interactive chrome (its degraded header): the
 * theme's colours, a 2.5rem bar with 12px sides and a hairline under it,
 * 13px/1.4 text, the title and the "user-generated" byline, and a 20px spinner
 * until the frame has loaded, which then fades in over 0.12s.
 */
export function sharePage(title: string, token: string, nonce: string) {
  const name = escapeHtml(title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${name} — Claudex</title><style>
:root{--bg:#fff;--fg:#0b0b0b;--mut:#52514e;--spin:#898781;--line:#0b0b0b1a;--div:#0b0b0b0d;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--mut:#c3c2b7;--line:#ffffff1a;--div:#ffffff0d}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;overscroll-behavior:none;background:var(--bg);color:var(--fg)}
body{font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
header{position:relative;display:flex;align-items:center;gap:8px;height:2.5rem;padding:0 12px;border-bottom:1px solid var(--div)}
.title{overflow:hidden;font-size:13px;font-weight:400;white-space:nowrap;text-overflow:ellipsis}
.byline{flex-shrink:0;max-width:312px;overflow:hidden;color:var(--mut);font-size:.75rem;white-space:nowrap;text-overflow:ellipsis}
main{position:absolute;inset:2.5rem 0 0 0;display:flex}
.slot{position:relative;flex:1;min-width:0}
.loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.loading::after{content:"";width:20px;height:20px;border:2px solid #0000;border-radius:50%;background:conic-gradient(transparent 40%,var(--spin)) border-box,linear-gradient(var(--line),var(--line)) border-box;-webkit-mask:radial-gradient(farthest-side,#0000 calc(100% - 2px),#000 calc(100% - 1.5px));mask:radial-gradient(farthest-side,#0000 calc(100% - 2px),#000 calc(100% - 1.5px));animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
iframe{position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0;transition:opacity .12s}
[data-ready] iframe{opacity:1}
[data-ready] .loading{display:none}
</style></head><body><header><span class="title">${name}</span> <span class="byline">${shareByline}</span></header><main><div class="slot"><div class="loading" role="status" aria-label="Loading"></div><iframe title="${name}" sandbox="allow-scripts" src="/content/${token}"></iframe></div></main><script nonce="${nonce}">(() => { const slot = document.querySelector(".slot"); const ready = () => { slot.setAttribute("data-ready", ""); slot.querySelector(".loading").removeAttribute("role"); }; slot.querySelector("iframe").addEventListener("load", ready, { once: true }); })();</script></body></html>`;
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.identity === "string" &&
    entry.identity.length <= 3000000 &&
    typeof entry.title === "string" &&
    entry.title.length <= 200 &&
    ["html", "svg"].includes(String(entry.language)) &&
    typeof entry.content === "string" &&
    Buffer.byteLength(entry.content) <= 2 * 1024 * 1024 &&
    ["private", "link"].includes(String(entry.visibility)) &&
    typeof entry.showInList === "boolean" &&
    (entry.visibility === "private" ||
      (typeof entry.token === "string" && /^[a-f0-9]{64}$/.test(entry.token)))
  );
}

/**
 * An artifact's public link on the Claudex service (R1, `HostedShares`).
 * ArtifactShares reads it so the cards and the Artifacts page see one
 * answer per artifact, and tells it when an artifact went private. A
 * published version keeps its content: it does not follow later changes.
 */
export interface HostedArtifactLinks {
  screenshot?(identity: string): string | undefined;
  /** The newest public address while the artifact has an active hosted share. */
  link(identity: string): string | undefined;
  /** Artifacts with an active hosted share that this computer knows. */
  identities(): string[];
  /** The person made the artifact private: its public links stop. */
  stop(identity: string): void;
}

/**
 * Local-only saved Artifact links. The listener never binds to a LAN
 * interface. It reuses the port it had last time, so links copied earlier
 * keep working after a restart unless another program took that port.
 */
export class ArtifactShares {
  private readonly filename: string;
  private readonly portFile: string;
  private entries: Entry[] = [];
  private server?: Server;
  private port?: number;
  /** The signed-in Claudex account's public links; none for a local account. */
  hosted?: HostedArtifactLinks;
  constructor(root: string) {
    this.filename = path.join(root, "artifact-shares.json");
    this.portFile = path.join(root, "artifact-shares-port");
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.filename, "utf8"),
      );
      if (!Array.isArray(parsed) || !parsed.every(validEntry))
        throw Error("Invalid Artifact share data.");
      this.entries = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Artifact share data cannot be read; the file has not been overwritten.",
        );
    }
  }
  private save() {
    const tmp = `${this.filename}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.filename);
  }
  private info(entry: Entry): ArtifactShareInfo {
    const { identity, visibility, showInList } = entry;
    const publicUrl = this.hosted?.link(identity);
    // A public link is what the artifact's link is: anyone can open it.
    if (publicUrl)
      return {
        identity,
        visibility: "link",
        showInList,
        url: publicUrl,
        scope: "public",
        publicUrl,
        screenshotUrl: this.hosted?.screenshot?.(identity),
      };
    return { identity, visibility, showInList, url: this.localUrl(entry) };
  }
  /** The entry's link on this computer, whether or not it is also public. */
  private localUrl({ visibility, token }: Entry) {
    return visibility === "link" && token && this.port
      ? `http://127.0.0.1:${this.port}/artifact/${token}`
      : undefined;
  }
  /** An artifact with no entry here: private, or public on the service. */
  private blank(identity: string): ArtifactShareInfo {
    if (!this.hosted?.link(identity))
      return { identity, visibility: "private", showInList: true };
    return this.info({
      identity,
      visibility: "private",
      showInList: true,
      title: "",
      language: "html",
      content: "",
    });
  }
  private check(input: ArtifactShareInput) {
    if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024)
      throw new Error("Artifact share exceeds 2 MB.");
  }
  list() {
    const local = this.entries.map((entry) => this.info(entry));
    const known = new Set(local.map((share) => share.identity));
    const hosted = (this.hosted?.identities() ?? [])
      .filter((identity) => !known.has(identity))
      .map((identity) => this.blank(identity));
    return [...local, ...hosted];
  }
  sync(input: ArtifactShareInput) {
    this.check(input);
    const entry = this.entries.find(
      (value) => value.identity === input.identity,
    );
    if (!entry) return this.blank(input.identity);
    // The page on this computer serves HTML and SVG only: other text keeps
    // the last copy it could serve. A public link keeps its published version.
    if (
      entry.visibility === "link" &&
      ["html", "svg"].includes(input.language) &&
      (entry.title !== input.title ||
        entry.language !== input.language ||
        entry.content !== input.content)
    ) {
      Object.assign(entry, {
        title: input.title,
        language: input.language,
        content: input.content,
      });
      this.save();
    }
    return this.info(entry);
  }
  update(
    input: ArtifactShareInput,
    patch: { visibility?: "private" | "link"; showInList?: boolean },
  ) {
    this.check(input);
    let entry = this.entries.find((value) => value.identity === input.identity);
    if (!entry) {
      entry = {
        identity: input.identity,
        visibility: "private",
        showInList: true,
        title: "",
        language: "html",
        content: "",
      };
      this.entries.push(entry);
    }
    if (patch.visibility === "link" && entry.visibility !== "link") {
      entry.token = randomBytes(32).toString("hex");
      entry.visibility = "link";
    } else if (patch.visibility === "private") {
      if (entry.visibility !== "private") {
        delete entry.token;
        entry.visibility = "private";
      }
      // Only you: the public link stops too.
      if (this.hosted?.link(input.identity)) this.hosted.stop(input.identity);
    }
    if (entry.visibility === "link")
      Object.assign(entry, {
        title: input.title,
        language: input.language,
        content: input.content,
      });
    else Object.assign(entry, { title: "", language: "html", content: "" });
    if (patch.showInList !== undefined) entry.showInList = patch.showInList;
    this.save();
    return this.info(entry);
  }
  /** Artifacts shared by link, with their titles (Privacy → Shared artifacts). */
  shared() {
    return this.entries
      .filter((entry) => entry.visibility === "link")
      .map((entry) => ({
        identity: entry.identity,
        title: entry.title || "Untitled artifact",
        // The local link: a public one is listed on its own (settings-account).
        url: this.localUrl(entry),
      }));
  }
  /** Makes a shared artifact private again; its old link stops working. */
  unshare(identity: string) {
    const entry = this.entries.find((value) => value.identity === identity);
    if (!entry || entry.visibility !== "link") return;
    delete entry.token;
    Object.assign(entry, {
      visibility: "private",
      title: "",
      language: "html",
      content: "",
    });
    this.save();
  }
  remove(identity: string) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.identity !== identity);
    if (this.entries.length !== before) this.save();
  }
  async start() {
    if (this.server) return;
    this.server = createServer((request, response) => {
      // No kept-alive sockets: a restart on the same port starts clean.
      response.shouldKeepAlive = false;
      const host = request.headers.host;
      const parsed =
        this.port && host === `127.0.0.1:${this.port}`
          ? new URL(request.url ?? "/", `http://${host}`)
          : undefined;
      const match =
        parsed &&
        /^\/(artifact|content)\/([a-f0-9]{64})$/.exec(parsed.pathname);
      const entry =
        match &&
        this.entries.find(
          (item) => item.visibility === "link" && item.token === match[2],
        );
      if (request.method !== "GET" || !entry || parsed?.search) {
        response.writeHead(404, { "Cache-Control": "no-store" });
        response.end("Not available");
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (match[1] === "content") {
        response.setHeader(
          "Content-Type",
          entry.language === "svg"
            ? "image/svg+xml; charset=utf-8"
            : "text/html; charset=utf-8",
        );
        response.setHeader("Content-Security-Policy", documentCsp);
        response.end(entry.content);
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      const nonce = randomBytes(16).toString("base64");
      response.setHeader("Content-Security-Policy", sharePageCsp(nonce));
      response.end(sharePage(entry.title, entry.token!, nonce));
    });
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(port, "127.0.0.1", () => {
          this.server!.off("error", reject);
          resolve();
        });
      });
    try {
      const previous = this.savedPort();
      try {
        await listen(previous ?? 0);
      } catch (error) {
        // Taken or refused: any free port will do.
        if (!previous) throw error;
        await listen(0);
      }
      const address = this.server.address();
      if (!address || typeof address === "string")
        throw Error("Invalid local server address.");
      this.port = address.port;
      if (this.port !== previous)
        try {
          fs.writeFileSync(this.portFile, String(this.port), { mode: 0o600 });
        } catch {
          // Links still work until the next restart.
        }
    } catch (error) {
      this.server?.close();
      this.server = undefined;
      throw error;
    }
  }
  private savedPort() {
    try {
      const port = Number(fs.readFileSync(this.portFile, "utf8").trim());
      return Number.isInteger(port) && port >= 1024 && port <= 65535
        ? port
        : undefined;
    } catch {
      return undefined;
    }
  }
  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
