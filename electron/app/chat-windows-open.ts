import type { Rectangle } from "electron";
import type { ToolPaneKind } from "../../shared/tool-pane";
import { clampToDisplays } from "./chat-windows-support";
import type { ChatWindows } from "./chat-windows";
import type { CheckedHandoff, OpenWindow } from "./chat-windows";

export async function openProject(
  this: ChatWindows,
  projectId: string,
  restored?: { bounds?: Rectangle; alwaysOnTop?: boolean },
) {
  const project = this.host.project?.(projectId);
  if (!project) throw new Error("This project no longer exists.");
  for (const [win, id] of this.projects) {
    if (id !== projectId || win.isDestroyed()) continue;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const win = this.host.createWindow({
    ...this.windowOptions(project.name),
    ...(restored?.bounds
      ? clampToDisplays(restored.bounds, this.host.workAreas())
      : {}),
  });
  if (restored?.alwaysOnTop) win.setAlwaysOnTop(true, "floating");
  this.projects.set(win, projectId);
  this.order.push(win);
  this.host.windows.register(win, { kind: "project", projectId });
  win.on("resize", () => this.scheduleSave(win));
  win.on("move", () => this.scheduleSave(win));
  win.on("close", () => this.saveNow(win));
  win.on("closed", () => {
    this.projects.delete(win);
    this.order = this.order.filter((entry) => entry !== win);
    this.saveLayout();
    if (!this.open.size && !this.projects.size && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  });
  this.startSweep();
  try {
    await this.host.windows.load(win, { window: "project", id: projectId });
    this.saveLayout();
  } catch (error) {
    this.projects.delete(win);
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
}

/** Opens the conversation's window, or focuses it when it is open. */
export async function openConversation(
  this: ChatWindows,
  conversationId: string,
  handoff?: CheckedHandoff,
  pane?: ToolPaneKind,
  restored?: { bounds: Rectangle; alwaysOnTop: boolean },
  showInactive = false,
) {
  const conversation = this.available(conversationId);
  const existing = this.forConversation(conversationId, pane);
  if (existing) {
    const entry = this.open.get(existing)!;
    // A draft reaches a window that has not read its handoff yet.
    if (handoff && !entry.handoffTaken) entry.handoff = handoff;
    if (showInactive) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const win = this.host.createWindow({
    ...this.windowOptions(conversation.title),
    ...(showInactive ? { show: false } : {}),
    ...(restored
      ? clampToDisplays(restored.bounds, this.host.workAreas())
      : {}),
  });
  if (restored?.alwaysOnTop) win.setAlwaysOnTop(true, "floating");
  const entry: OpenWindow = {
    conversationId,
    pane,
    win,
    handoff,
    handoffTaken: false,
    visible: false,
  };
  this.open.set(win, entry);
  this.order.push(win);
  this.host.windows.register(win, { kind: "conversation", conversationId });
  win.on("resize", () => this.scheduleSave(win));
  win.on("move", () => this.scheduleSave(win));
  win.on("close", () => this.saveNow(win));
  // A minimized or hidden window cannot be seen, whatever its page said last.
  win.on("minimize", () => this.reportVisibility(win, false));
  win.on("hide", () => this.reportVisibility(win, false));
  win.on("closed", () => this.forget(win));
  this.startSweep();
  try {
    await this.host.windows.load(win, {
      window: "conversation",
      id: conversationId,
      ...(pane ? { pane } : {}),
    });
    if (showInactive && !win.isDestroyed()) win.showInactive();
    this.saveLayout();
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    this.forget(win);
    throw error;
  }
}
