/**
 * Announcements: pop-up notices the administrator publishes in the Claudex
 * console. Every signed-in user sees each one once: the window asks for the
 * pending ones when it starts (and every so often), shows the oldest, and
 * reports which button was pressed, after which that announcement never
 * comes back for them. An announcement the administrator withdrew, or whose
 * time is up, is not returned even if it was never read.
 */
import { z } from "zod";
import { bridgeMethods } from "./bridge-methods";
import type { Announcement as PolicyAnnouncement } from "./client-policy";

/** How a person closed an announcement. */
export const announcementAction = z.enum(["primary", "dismiss", "close"]);
export type AnnouncementAction = z.infer<typeof announcementAction>;

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

export interface ServiceAnnouncement extends PolicyAnnouncement {
  readAt: number | null;
}

export interface OfficialAnnouncements {
  notices(): Promise<ServiceAnnouncement[]>;
  pending(): Promise<Announcement[]>;
  markRead(id: string): Promise<void>;
  close(id: number, action: AnnouncementAction): Promise<void>;
}

export const serviceAnnouncementsPath = "/announcements";
export const popupAnnouncementsPath = "/claudex/announcements";

export const announcementsMethods = bridgeMethods<AnnouncementsAPI>({
  pendingAnnouncements: true,
  closeAnnouncement: true,
});

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : "";

const time = (value: string | null) => {
  const at = value === null ? NaN : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

interface RemoteAnnouncement extends ServiceAnnouncement {
  startsAt: number | null;
  endsAt: number | null;
}

const announcementRow = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  content: z.string().catch(""),
  notify_mode: z.string().catch(""),
  starts_at: z.string().nullable().catch(null),
  ends_at: z.string().nullable().catch(null),
  read_at: z.string().nullable().catch(null),
  created_at: z.string().nullable().catch(null),
});

export function remoteAnnouncementsFrom(
  items: unknown[],
): RemoteAnnouncement[] {
  return items.flatMap((row: unknown) => {
    const parsed = announcementRow.safeParse(row);
    if (!parsed.success) return [];
    const item = parsed.data;
    const readAt = time(item.read_at);
    return [
      {
        id: String(item.id),
        title: text(item.title, 200),
        content: item.content,
        popup: item.notify_mode === "popup",
        startsAt: time(item.starts_at),
        endsAt: time(item.ends_at),
        readAt,
        read: readAt !== null,
        createdAt: time(item.created_at) ?? 0,
      },
    ];
  });
}

export function serviceAnnouncementsFrom(
  answer: unknown,
): ServiceAnnouncement[] {
  if (!Array.isArray(answer))
    throw Error("The Claudex service sent an unexpected announcement feed.");
  return sortServiceAnnouncements(remoteAnnouncementsFrom(answer));
}

export function sortServiceAnnouncements(
  items: RemoteAnnouncement[],
): ServiceAnnouncement[] {
  return items
    .map(({ startsAt, endsAt, ...item }) => item)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function pendingAnnouncementsFrom(answer: unknown): Announcement[] {
  if (
    !answer ||
    typeof answer !== "object" ||
    !("items" in answer) ||
    !Array.isArray(answer.items)
  )
    throw Error("The Claudex service sent an unexpected announcement queue.");
  return announcementsFrom(answer.items);
}

const secureUrl = (value: unknown) => {
  const raw = text(value, 2048).trim();
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? raw : "";
  } catch {
    return "";
  }
};

const popupRow = z.object({
  id: z.number().int().positive(),
  badge: z.unknown().optional(),
  title: z.unknown().optional(),
  body_html: z.unknown().optional(),
  body_format: z.unknown().optional(),
  image_url: z.unknown().optional(),
  primary_label: z.unknown().optional(),
  primary_url: z.unknown().optional(),
  dismiss_label: z.unknown().optional(),
});

/** The service's `data.items` as the window uses them; anything malformed is dropped. */
export function announcementsFrom(items: unknown): Announcement[] {
  if (!Array.isArray(items)) return [];
  const out: Announcement[] = [];
  for (const raw of items.slice(0, 20)) {
    const parsed = popupRow.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data;
    const title = text(item.title, 200);
    const bodyHtml = text(item.body_html, 200_000);
    if (!title && !bodyHtml.trim()) continue;
    out.push({
      id: item.id,
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
