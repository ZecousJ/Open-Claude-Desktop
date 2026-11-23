import type { Turn } from "../../shared/types";

/** Host-only marker; renderer and wire payloads cannot supply symbols. */
export const officialCoworkSend = Symbol("official Cowork send");
export const officialCoworkFollowupEvent = Symbol("official Cowork follow-up event");

/** Automatic model fallback inherits the host-only choice for the running turn. */
export const nativeCoworkSearchIntents = new WeakMap<Turn, boolean>();
