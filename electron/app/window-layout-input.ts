import { z } from "zod";

const id = z.string().min(1).max(256);
const bounds = z.object({
  x: z.number().int().min(-100000).max(100000),
  y: z.number().int().min(-100000).max(100000),
  width: z.number().int().positive().max(20000),
  height: z.number().int().positive().max(20000),
});
const geometry = {
  title: z.string().max(512).optional(),
  alwaysOnTop: z.boolean().optional(),
  bounds: bounds.optional(),
};
export const sessionPopoutSchema = z.object({
  sessionId: id,
  sessionType: z.string().min(1).max(64),
  isSsh: z.boolean().optional(),
  ...geometry,
});
const paneKey = z.object({
  sessionId: id,
  paneTileId: z.string().min(1).max(512),
});
export const openLayoutSchema = z.object({
  popouts: z.array(sessionPopoutSchema).max(50),
  panes: z
    .array(
      sessionPopoutSchema.extend({
        paneTileId: paneKey.shape.paneTileId,
        view: z.string().max(4096).optional(),
      }),
    )
    .max(50),
  projects: z
    .array(z.object({ projectId: id, ...geometry }))
    .max(50)
    .default([]),
  handledPanes: z.array(paneKey).max(50).optional(),
  handledProjects: z.array(id).max(50).optional(),
});
export const layoutResultSchema = z.object({
  requestId: z.string().min(1).max(64),
  outcome: z.enum(["done", "noop", "refused", "failed"]),
  reason: z.string().max(64).optional(),
  paneIndex: z.number().int().nonnegative().optional(),
  layout: z
    .object({
      mode: z.string().max(32),
      sidebarCollapsed: z.boolean(),
      primarySessionId: id.optional(),
      primaryFocused: z.boolean(),
      panes: z
        .array(
          z.object({
            index: z.number(),
            col: z.number(),
            row: z.number(),
            kind: z.string().max(32),
            sessionId: id.optional(),
            focused: z.boolean(),
          }),
        )
        .max(50),
      popoutSessionIds: z.array(id).max(50),
      otherPopoutCount: z.number(),
      caller: z.object({
        primary: z.boolean(),
        paneIndex: z.number().optional(),
        popout: z.boolean(),
      }),
    })
    .optional(),
});
