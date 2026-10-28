import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BrowserSavedPage } from "../../shared/browser";

/** The largest saved frame (base64 characters): the whole file is rewritten
 * on each change, so it stays small. */
const maxSavedFrame = 1_500_000;

/** Last frames, not live pages, restored after quit. */
export class PreviewPages {
  private pages: Record<string, BrowserSavedPage> = {};
  private file: string;

  constructor(directory: string, accountId: string) {
    const account = createHash("sha256")
      .update(accountId)
      .digest("hex")
      .slice(0, 16);
    this.file = path.join(directory, `preview-pages-${account}.json`);
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        for (const [id, page] of Object.entries(saved))
          if (
            page &&
            typeof page === "object" &&
            typeof page.url === "string" &&
            /^https?:\/\//.test(page.url) &&
            typeof page.title === "string" &&
            typeof page.jpegBase64 === "string" &&
            page.jpegBase64.length <= maxSavedFrame &&
            /^[A-Za-z0-9+/=]+$/.test(page.jpegBase64)
          )
            this.pages[id] = {
              url: page.url,
              title: page.title,
              jpegBase64: page.jpegBase64,
              ...(typeof page.serverName === "string"
                ? { serverName: page.serverName }
                : {}),
            };
    } catch {}
  }

  get(id: string) {
    return this.pages[id];
  }

  set(id: string, page: BrowserSavedPage | undefined) {
    if (page && page.jpegBase64.length > maxSavedFrame) return;
    if (page) {
      delete this.pages[id];
      this.pages[id] = page;
    } else delete this.pages[id];
    while (Object.keys(this.pages).length > 32)
      delete this.pages[Object.keys(this.pages)[0]];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.pages), {
      mode: 0o600,
    });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  prune(conversationIds: ReadonlySet<string>) {
    for (const id of Object.keys(this.pages))
      if (!conversationIds.has(id)) this.set(id, undefined);
  }
}
