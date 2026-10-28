import type { Rectangle } from "electron";

import path from "node:path";
import fs from "node:fs";
import type { ChatWindowState } from "./chat-windows";
import { toolPaneKinds } from "../../shared/tool-pane";
import { z } from "zod";
/** Size a first window opens at. */
export const defaultChatWindowSize = { width: 900, height: 700 };

/** The smallest window the conversation column and composer still fit. */
export const minChatWindowSize = { width: 480, height: 400 };

/** How far a new window sits from the one it opens over. */
export const cascadeOffset = 24;

export const stateSchema = z.object({
  version: z.literal(1),
  last: z.object({
    width: z.number().int().min(minChatWindowSize.width).max(20000),
    height: z.number().int().min(minChatWindowSize.height).max(20000),
    x: z.number().int().min(-100000).max(100000),
    y: z.number().int().min(-100000).max(100000),
  }),
});

// .
export const layoutSchema = z.object({
  version: z.literal(1),
  windows: z
    .array(
      z.object({
        conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        pane: z.enum(toolPaneKinds).optional(),
        bounds: stateSchema.shape.last,
        alwaysOnTop: z.boolean(),
      }),
    )
    .max(100),
});

/** Reads the remembered geometry; anything missing or invalid means "none". */
export function readChatWindowState(
  file: string | undefined,
): ChatWindowState | undefined {
  if (!file) return undefined;
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeChatWindowState(file: string, state: ChatWindowState) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Keeps a window on screen: on the display it overlaps most (the primary
 * one when it is off every display or barely visible), no larger than that
 * display's work area and moved inside it.
 */
export function clampToDisplays(
  bounds: Rectangle,
  workAreas: Rectangle[],
): Rectangle {
  if (!workAreas.length) return bounds;
  let area = workAreas[0];
  let best = 0;
  for (const candidate of workAreas) {
    const shared = overlap(bounds, candidate);
    if (
      shared &&
      shared.width >= minVisible.width &&
      shared.height >= minVisible.height &&
      shared.width * shared.height > best
    ) {
      best = shared.width * shared.height;
      area = candidate;
    }
  }
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

/** How much of a window must stay on a display to be reachable. */
export const minVisible = { width: 120, height: 48 };

export function overlap(a: Rectangle, b: Rectangle) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
