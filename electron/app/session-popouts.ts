import fs from "node:fs";
import path from "node:path";
import type { OpenLayout } from "../../shared/window-layout";
import { openLayoutSchema } from "./window-layout-input";

const empty = (): OpenLayout => ({ popouts: [], panes: [], projects: [] });
const paneKey = (pane: { sessionId: string; paneTileId: string }) =>
  JSON.stringify([pane.sessionId, pane.paneTileId]);

// .
export class SessionPopouts {
  private pending: OpenLayout | null = null;
  private unhandled = empty();
  private loadedAt = 0;
  private claimedAt = 0;
  private loaded = false;
  private readFailed = false;
  constructor(
    private file: () => string | undefined,
    private now = Date.now,
  ) {}

  take(): OpenLayout | null {
    this.load();
    const layout = this.pending;
    this.pending = null;
    if (!layout || this.now() - this.loadedAt > 600000) return null;
    this.claimedAt = this.now();
    this.unhandled = layout;
    return structuredClone(layout);
  }

  report(raw: OpenLayout, legacyWindows?: unknown[]) {
    this.load();
    if (this.readFailed || this.pending) return;
    const layout = openLayoutSchema.parse(raw);
    const sessions = new Set(layout.popouts.map((entry) => entry.sessionId));
    const panes = new Set(
      [...layout.panes, ...(layout.handledPanes ?? [])].map(paneKey),
    );
    const projects = new Set([
      ...layout.projects.map((entry) => entry.projectId),
      ...(layout.handledProjects ?? []),
    ]);
    this.unhandled = {
      popouts: this.unhandled.popouts.filter(
        (entry) => !sessions.has(entry.sessionId),
      ),
      panes: this.unhandled.panes.filter((entry) => !panes.has(paneKey(entry))),
      projects: this.unhandled.projects?.filter(
        (entry) => !projects.has(entry.projectId),
      ),
    };
    const carry =
      this.now() - this.claimedAt <= 600000 ? this.unhandled : empty();
    const unique = <T>(entries: T[], key: (entry: T) => string) =>
      [...new Map(entries.map((entry) => [key(entry), entry])).values()].slice(
        0,
        50,
      );
    const saved = {
      version: 1,
      popouts: unique(
        [...layout.popouts, ...carry.popouts],
        (entry) => entry.sessionId,
      ),
      panes: unique([...layout.panes, ...carry.panes], paneKey),
      projects: unique(
        [...layout.projects, ...(carry.projects ?? [])],
        (entry) => entry.projectId,
      ),
      ...(legacyWindows ? { windows: legacyWindows } : {}),
    };
    const file = this.file();
    if (!file) return;
    let text = JSON.stringify(saved);
    if (Buffer.byteLength(text) > 524288)
      text = JSON.stringify({ ...saved, panes: [] });
    if (Buffer.byteLength(text) > 524288) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) {
      console.error("Pop-out layout could not be saved:", error);
    }
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.file();
    if (!file) return;
    try {
      if (fs.statSync(file).size > 524288) {
        this.readFailed = true;
        return;
      }
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw.version !== 1) {
        this.readFailed = true;
        return;
      }
      if (!raw.popouts && Array.isArray(raw.windows)) {
        raw.popouts = raw.windows
          .filter((entry: { pane?: string }) => !entry.pane)
          .map((entry: { conversationId: string }) => ({
            ...entry,
            sessionId: entry.conversationId,
            sessionType: "code",
          }));
        raw.panes = raw.windows
          .filter((entry: { pane?: string }) => entry.pane)
          .map((entry: { conversationId: string; pane: string }) => ({
            ...entry,
            sessionId: entry.conversationId,
            sessionType: "code",
            paneTileId: entry.pane,
          }));
      }
      this.pending = openLayoutSchema.parse(raw);
      this.loadedAt = this.now();
    } catch (error) {
      this.readFailed = (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
}
