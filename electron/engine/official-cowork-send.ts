import type { Turn } from "../../shared/types";

/** Host-only marker; renderer and wire payloads cannot supply symbols. */
export const officialCoworkSend = Symbol("official Cowork send");

/** Automatic model fallback inherits the host-only choice for the running turn. */
export const nativeCoworkSearchIntents = new WeakMap<Turn, boolean>();
