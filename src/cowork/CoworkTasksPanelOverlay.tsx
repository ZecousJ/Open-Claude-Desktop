import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CoworkTasksPanel } from "./CoworkTasksPanel";
import { tasksPanelWidth } from "./task-sections";

/** The rail belongs to the available conversation content, after the app
 * sidebar and any existing viewer, not to a third app-grid column. */
export function CoworkTasksPanelOverlay(
  props: Parameters<typeof CoworkTasksPanel>[0],
) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(() => {
    try {
      return tasksPanelWidth(
        Number(localStorage.getItem("dispatch.taskPanel.width")) || 320,
      );
    } catch {
      return 320;
    }
  });
  useLayoutEffect(() => {
    const find = () =>
      setContainer(
        document.querySelector<HTMLElement>(
          ".app > .workspace > .chat-layout > .chat-main",
        ),
      );
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { subtree: true, childList: true });
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!container) return;
    const property = "--cowork-task-rail-width";
    const previous = container.style.getPropertyValue(property);
    const value = `${width}px`;
    container.style.setProperty(property, value);
    return () => {
      if (container.style.getPropertyValue(property) !== value) return;
      if (previous) container.style.setProperty(property, previous);
      else container.style.removeProperty(property);
    };
  }, [container, width]);
  return container
    ? createPortal(
        <div className="cowork-task-rail-slot">
          <CoworkTasksPanel {...props} onWidthChange={setWidth} />
        </div>,
        container,
      )
    : null;
}
