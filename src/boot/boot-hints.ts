/** Cached visual preferences for the web app: the initial background and
 * theme, the remembered sidebar width, and the next real home's greeting.
 * web.html restores only the theme/background before the renderer starts.
 */
import { timeOfDayGreeting } from "../../shared/home-greeting";
import {
  maximumSidebarWidth,
  minimumSidebarWidth,
} from "../../shared/sidebar-layout";
import { collapseThreshold } from "../sidebar/sidebar-visibility";

export const bootHintsKey = "claudex.boot";

/**
 * The greeting the next home view shows: written by the previous view for
 * the time of day it was written in.
 */
export type BootGreeting = {
  /** "Good morning" | "Good afternoon" | "Good evening" (timeOfDayGreeting). */
  slot: string;
  /** The choice among that slot's greetings (homeGreeting's roll). */
  roll: number;
  /** The sentence as shown, translated, with the name. */
  text: string;
};

export type BootHints = {
  /** Signed in when this device last knew (the session cookie is HttpOnly). */
  signedIn?: boolean;
  /** The theme setting: dark, light or system. */
  theme?: string;
  greeting?: BootGreeting;
  /** The sidebar's stored width, which moves the collapse line. */
  sidebarWidth?: number;
  /**
   * The sidebar was closed by the user at a normal width; it starts closed
   * again (the original keeps `collapsed` with its width in dframe-store).
   */
  sidebarCollapsed?: boolean;
};

export function readBootHints(): BootHints {
  try {
    const value = JSON.parse(localStorage.getItem(bootHintsKey) ?? "{}");
    return value && typeof value === "object" ? (value as BootHints) : {};
  } catch {
    return {};
  }
}

export function writeBootHints(patch: BootHints) {
  try {
    const next = { ...readBootHints(), ...patch };
    localStorage.setItem(bootHintsKey, JSON.stringify(next));
  } catch {
    /* no storage: the first paint falls back to the defaults */
  }
}

/** The theme to paint with: the setting, else the system's (for "system" and a first visit). */
export function bootTheme(theme: string | undefined, systemDark: boolean) {
  if (theme === "dark" || theme === "light") return theme;
  // "system", and a first visit (nothing chosen here yet): the device's.
  return systemDark ? "dark" : "light";
}

/** The stored sidebar width when it is one the settings allow. */
export function bootSidebarWidth(hints: BootHints): number | undefined {
  const width = hints.sidebarWidth;
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width >= minimumSidebarWidth &&
    width <= maximumSidebarWidth
    ? width
    : undefined;
}

/**
 * The sidebar's collapse threshold for a remembered width, shared with its
 * initial visibility calculation.
 */
export function bootSidebarNarrow(hints: BootHints, viewport: number) {
  return viewport <= collapseThreshold(bootSidebarWidth(hints));
}

/**
 * Whether the address opens an empty new chat (`/`, `/new`), excluding a
 * prompt supplied through `?q=`.
 */
export function bootNewChat(pathname: string, search: string) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return (
    (path === "/" || path === "/new") && !new URLSearchParams(search).has("q")
  );
}

/**
 * The cached greeting for the current time of day, when one is available.
 */
export function bootGreeting(
  hints: BootHints,
  hour: number,
  search: string,
): BootGreeting | undefined {
  const greeting = hints.greeting;
  if (
    !greeting ||
    typeof greeting.text !== "string" ||
    !greeting.text ||
    typeof greeting.roll !== "number" ||
    greeting.slot !== timeOfDayGreeting(hour) ||
    // An incognito chat greets differently ("You’re incognito").
    new URLSearchParams(search).has("incognito")
  )
    return undefined;
  return greeting;
}

/**
 * The first home view after the app starts uses the cached greeting;
 * later views choose their own (`firstHomeViewShown` after it mounts).
 */
let firstHomeView = true;
export function firstHomeGreeting(hour: number, search: string) {
  return firstHomeView
    ? bootGreeting(readBootHints(), hour, search)
    : undefined;
}
export function firstHomeViewShown() {
  firstHomeView = false;
}
