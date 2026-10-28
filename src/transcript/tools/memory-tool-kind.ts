import type { Item } from "../../../shared/types";

/** electron/memory/tools.ts memoryNamespace; kept literal so the window does not import main-process code. */
export const memoryToolNamespace = "claudex_memory";

/** A memory tool call (its row, MemoryToolView, loads when one shows). */
export const isMemoryTool = (item: Item) =>
  item.type === "dynamicToolCall" && item.namespace === memoryToolNamespace;
