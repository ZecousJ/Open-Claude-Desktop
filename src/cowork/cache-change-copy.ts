import type { CacheChangeKind } from "../../shared/cowork-cache";

/** Cowork cache-miss confirmation. */
export const cacheChangeTitles: Record<CacheChangeKind, string> = {
  model: "Switch model?",
  effort: "Change effort level?",
  thinking: "Change thinking mode?",
};
export const cacheChangeBodies: Record<CacheChangeKind, string> = {
  model:
    "Your next response will be slower and use more tokens. This task is cached for the current model. Switching to <bold>{targetLabel}</bold> means the full history gets re-read on your next message.",
  effort:
    "Your next response will be slower and use more tokens. This task is cached for the current effort level. Switching to <bold>{targetLabel}</bold> means the full history gets re-read on your next message.",
  thinking:
    "Your next response will be slower and use more tokens. This task is cached for the current thinking mode. Switching to <bold>{targetLabel}</bold> means the full history gets re-read on your next message.",
};
