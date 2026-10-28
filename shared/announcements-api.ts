/**
 * Announcements: pop-up notices the administrator publishes in the Claudex
 * console. Every signed-in user sees each one once: the window asks for the
 * pending ones when it starts (and every so often), shows the oldest, and
 * reports which button was pressed, after which that announcement never
 * comes back for them. An announcement the administrator withdrew, or whose
 * time is up, is not returned even if it was never read.
 */
import { bridgeMethods } from "./bridge-methods";

/** How a person closed an announcement. */
export type AnnouncementAction = "primary" | "dismiss" | "close";

export interface Announcement {
  id: number;
  badge: string;
  title: string;
  /**
   * The content: with "text" (the template's default) each line is a
   * paragraph; with "html" it is the administrator's own HTML, drawn in a
   * frame without scripts.
   */
  bodyHtml: string;
  bodyFormat: "text" | "html";
  /** An https address, or "" for a one-column pop-up. */
  imageUrl: string;
  primaryLabel: string;
  /**
   * Opened in the system browser when the main button is pressed. With none
   * the pop-up has one plain button (primaryLabel, "Done" when empty).
   */
  primaryUrl: string;
  /** The second button, beside a main button with a link; "" means "Not now". */
  dismissLabel: string;
}

export interface AnnouncementsAPI {
  /** The announcements this person has not closed, oldest first. */
  pendingAnnouncements(): Promise<Announcement[]>;
  /** Records the close; the announcement is not offered again. */
  closeAnnouncement(id: number, action: AnnouncementAction): Promise<void>;
}

export const announcementsMethods = bridgeMethods<AnnouncementsAPI>({
  pendingAnnouncements: true,
  closeAnnouncement: true,
});

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : "";

const secureUrl = (value: unknown) => {
  const raw = text(value, 2048).trim();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : "";
  } catch {
    return "";
  }
};

/** The service's `data.items` as the window uses them; anything malformed is dropped. */
export function announcementsFrom(items: unknown): Announcement[] {
  if (!Array.isArray(items)) return [];
  const out: Announcement[] = [];
  for (const raw of items.slice(0, 20)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.id) || (item.id as number) <= 0) continue;
    const title = text(item.title, 200);
    const bodyHtml = text(item.body_html, 200_000);
    if (!title && !bodyHtml.trim()) continue;
    out.push({
      id: item.id as number,
      badge: text(item.badge, 40),
      title,
      bodyHtml,
      bodyFormat: item.body_format === "html" ? "html" : "text",
      imageUrl: secureUrl(item.image_url),
      primaryLabel: text(item.primary_label, 60),
      primaryUrl: secureUrl(item.primary_url),
      dismissLabel: text(item.dismiss_label, 60),
    });
  }
  return out;
}
