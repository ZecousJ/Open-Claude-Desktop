export const startupSections = ["sidebar", "header", "content", "composer"] as const;
export type StartupSection = typeof startupSections[number];

export interface StartupPaint {
  type: "claudex:official-boot-progress";
  ready: StartupSection[];
  sidebarWidth: number | null;
  composerTop: number | null;
}

export function readStartupPaint(document: Document, chat: boolean, collapsed: boolean): StartupPaint {
  const shown = (element: Element | null) =>
    !!element?.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const sidebar = document.querySelector('[data-testid="sidebar"]');
  const header = document.querySelector('[data-testid="chat-header"]');
  const composer = document.querySelector('[data-testid="chat-input"]');
  const transcript = document.querySelector('[data-testid="transcript-list"], [data-testid="conversation-loading-placeholder"]');
  const ready: StartupSection[] = [];
  if (collapsed || (shown(sidebar) && shown(document.querySelector('[data-nav-item]')) &&
      document.fonts.check("500 20px anthropic-serif"))) ready.push("sidebar");
  if (!chat || shown(header)) ready.push("header");
  if (!chat || shown(transcript)) ready.push("content");
  if (shown(composer)) ready.push("composer");
  return {
    type: "claudex:official-boot-progress",
    ready,
    sidebarWidth: shown(sidebar) ? sidebar!.getBoundingClientRect().width
      : shown(header) ? (header!.closest('[role="toolbar"]') ?? header!).getBoundingClientRect().left : collapsed ? 0 : null,
    composerTop: shown(composer) ? (composer!.closest(".rounded-composer") ?? composer!).getBoundingClientRect().top : null,
  };
}

export function isStartupPaint(value: unknown): value is StartupPaint {
  if (!value || typeof value !== "object" || !("type" in value) ||
      value.type !== "claudex:official-boot-progress" || !("ready" in value) ||
      !Array.isArray(value.ready) || !value.ready.every(part => startupSections.some(section => section === part))) return false;
  return ["sidebarWidth", "composerTop"].every(key =>
    key in value && (Reflect.get(value, key) === null ||
      typeof Reflect.get(value, key) === "number" && Number.isFinite(Reflect.get(value, key))));
}
