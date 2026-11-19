import fs from "node:fs";
import path from "node:path";
import type { OpenLayout, PopoutBounds } from "../../shared/window-layout";
import { clampToDisplays, layoutSchema, overlap } from "./chat-windows-support";
import { openLayoutSchema } from "./window-layout-input";

const restoreTimeout = 600000;
const maxLayoutBytes = 524288;
const maxGroupSize = 50;

type StoredLayout = ReturnType<typeof openLayoutSchema.parse>;
type TimedLayout = { layout: StoredLayout; at: number };
type LayoutState =
  | { kind: "unloaded" | "unreadable" | "discarded" }
  | { kind: "pending"; snapshot: TimedLayout }
  | { kind: "ready"; current?: StoredLayout; claim?: TimedLayout };

const empty = (): StoredLayout => ({ popouts: [], panes: [], projects: [] });
const paneKey = (pane: { sessionId: string; paneTileId: string }) =>
  JSON.stringify([pane.sessionId, pane.paneTileId]);

export function clampLayoutToDisplays(
  layout: OpenLayout,
  workAreas: PopoutBounds[],
) {
  return mapLayoutBounds(layout, (bounds) =>
    clampToDisplays(bounds, workAreas),
  );
}

export function clampOfficialLayoutToDisplays(
  layout: OpenLayout,
  workAreas: PopoutBounds[],
  matchingArea: (bounds: PopoutBounds) => PopoutBounds,
) {
  let relocated = 0;
  return mapLayoutBounds(layout, (bounds) => {
    const visibleArea = overlappingWorkArea(bounds, workAreas);
    if (
      visibleArea &&
      bounds.width <= visibleArea.width &&
      bounds.height <= visibleArea.height
    )
      return bounds;

    const area = visibleArea ?? matchingArea(bounds);
    const width = Math.min(bounds.width, area.width);
    const height = Math.min(bounds.height, area.height);
    const x = visibleArea
      ? Math.max(bounds.x, area.x)
      : area.x + Math.floor((area.width - width) / 2);
    const y = visibleArea
      ? Math.max(bounds.y, area.y)
      : area.y + Math.floor((area.height - height) / 2);
    const offset = relocated++ * 32;
    return {
      x: Math.min(x + offset, area.x + area.width - width),
      y: Math.min(y + offset, area.y + area.height - height),
      width,
      height,
    };
  });
}

function overlappingWorkArea(bounds: PopoutBounds, workAreas: PopoutBounds[]) {
  let area: PopoutBounds | undefined;
  for (const workArea of workAreas) {
    const shared = overlap(bounds, workArea);
    if (!shared || shared.width < 64 || shared.height < 64) continue;
    if (!area) {
      area = workArea;
      continue;
    }
    const x = Math.min(area.x, workArea.x);
    const y = Math.min(area.y, workArea.y);
    area = {
      x,
      y,
      width: Math.max(area.x + area.width, workArea.x + workArea.width) - x,
      height: Math.max(area.y + area.height, workArea.y + workArea.height) - y,
    };
  }
  return area;
}

function mapLayoutBounds(
  layout: OpenLayout,
  adjust: (bounds: PopoutBounds) => PopoutBounds,
) {
  const clamp = <T extends { bounds?: PopoutBounds }>(entry: T): T =>
    entry.bounds ? { ...entry, bounds: adjust(entry.bounds) } : entry;
  return {
    ...layout,
    popouts: layout.popouts.map(clamp),
    panes: layout.panes.map(clamp),
    projects: layout.projects?.map(clamp),
  };
}

export class SessionPopouts {
  private state: LayoutState = { kind: "unloaded" };
  constructor(
    private file: () => string | undefined,
    private now = Date.now,
  ) {}

  take(): OpenLayout | null {
    this.load();
    if (this.state.kind !== "pending") return null;
    const { layout, at } = this.state.snapshot;
    const now = this.now();
    if (now - at > restoreTimeout) {
      this.state = { kind: "ready" };
      return null;
    }
    this.state = { kind: "ready", claim: { layout, at: now } };
    return structuredClone(layout);
  }

  reoffer(): void {
    if (this.state.kind !== "ready") return;
    const { current, claim } = this.state;
    const at = this.now();
    const carry = unexpiredClaim(claim, at)?.layout;
    const layout = mergeLayout(current, carry);
    if (current && claim && !carry) this.save(layout);
    this.state =
      layout.popouts.length || layout.panes.length || layout.projects.length
        ? { kind: "pending", snapshot: { layout, at } }
        : { kind: "ready" };
  }

  discard(): void {
    if (this.state.kind === "discarded") return;
    this.state = { kind: "discarded" };
    const file = this.file();
    if (!file) return;
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    } catch (error) {
      console.error("Pop-out layout could not be discarded:", error);
    }
  }

  report(raw: OpenLayout, legacyWindows?: unknown[]) {
    this.load();
    if (this.state.kind !== "ready") return;
    const layout = openLayoutSchema.parse(raw);
    const claim = unexpiredClaim(this.state.claim, this.now());
    let carry: StoredLayout | undefined;
    if (claim) {
      const sessions = new Set(layout.popouts.map((entry) => entry.sessionId));
      const panes = new Set(
        [...layout.panes, ...(layout.handledPanes ?? [])].map(paneKey),
      );
      const projects = new Set([
        ...layout.projects.map((entry) => entry.projectId),
        ...(layout.handledProjects ?? []),
      ]);
      carry = {
        popouts: claim.layout.popouts.filter(
          (entry) => !sessions.has(entry.sessionId),
        ),
        panes: claim.layout.panes.filter((entry) => !panes.has(paneKey(entry))),
        projects: claim.layout.projects.filter(
          (entry) => !projects.has(entry.projectId),
        ),
      };
    }
    this.state = {
      kind: "ready",
      current: layout,
      claim: claim && carry ? { layout: carry, at: claim.at } : undefined,
    };
    this.save(mergeLayout(layout, carry), legacyWindows);
  }

  private save(layout: StoredLayout, legacyWindows?: unknown[]) {
    const saved = {
      version: 1,
      ...layout,
      ...(legacyWindows ? { windows: legacyWindows } : {}),
    };
    const file = this.file();
    if (!file) return;
    let text = JSON.stringify(saved);
    if (Buffer.byteLength(text) > maxLayoutBytes)
      text = JSON.stringify({ ...saved, panes: [] });
    if (Buffer.byteLength(text) > maxLayoutBytes) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) {
      console.error("Pop-out layout could not be saved:", error);
    }
  }

  private load() {
    if (this.state.kind !== "unloaded") return;
    this.state = { kind: "ready" };
    const file = this.file();
    if (!file) return;
    try {
      if (fs.statSync(file).size > maxLayoutBytes) {
        this.state = { kind: "unreadable" };
        return;
      }
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("version" in raw) ||
        raw.version !== 1
      ) {
        this.state = { kind: "unreadable" };
        return;
      }
      const layout =
        "popouts" in raw
          ? openLayoutSchema.parse(raw)
          : migrateLegacyLayout(raw);
      this.state = { kind: "pending", snapshot: { layout, at: this.now() } };
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        this.state = { kind: "unreadable" };
    }
  }
}

function unexpiredClaim(claim: TimedLayout | undefined, at: number) {
  return claim && at - claim.at <= restoreTimeout ? claim : undefined;
}

function mergeLayout(layout = empty(), carry = empty()): StoredLayout {
  const unique = <T>(entries: T[], key: (entry: T) => string) =>
    [...new Map(entries.map((entry) => [key(entry), entry])).values()].slice(
      0,
      maxGroupSize,
    );
  return {
    popouts: unique(
      [...layout.popouts, ...carry.popouts],
      (entry) => entry.sessionId,
    ),
    panes: unique([...layout.panes, ...carry.panes], paneKey),
    projects: unique(
      [...layout.projects, ...carry.projects],
      (entry) => entry.projectId,
    ),
  };
}

function migrateLegacyLayout(raw: unknown): StoredLayout {
  const { windows } = layoutSchema.parse(raw);
  const layout = empty();
  for (const { conversationId, pane, ...geometry } of windows) {
    const entry = {
      ...geometry,
      sessionId: conversationId,
      sessionType: "code",
    };
    if (pane) layout.panes.push({ ...entry, paneTileId: pane });
    else layout.popouts.push(entry);
  }
  layout.popouts.length = Math.min(layout.popouts.length, maxGroupSize);
  layout.panes.length = Math.min(layout.panes.length, maxGroupSize);
  return layout;
}
