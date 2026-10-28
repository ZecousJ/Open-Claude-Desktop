import { useLayoutEffect, useRef, type ReactNode } from "react";
import { springPanels } from "../ui/spring-panels";

/**
 * How the chat page arranges its parts: the title bar (or the home's corner
 * actions), the conversation column and the panels beside it. WP5b changes the
 * arrangement here, for example a conversation column with its own title bar
 * next to full-height panel cards, without editing the parts or AppPages.tsx.
 */
export function ConversationLayout({
  header,
  main,
  panels,
}: {
  header: ReactNode;
  /** The `.chat-main` column: transcript and composer, or the home. */
  main: ReactNode;
  /** RightPanels: the file viewer or a tool panel. */
  panels: ReactNode;
}) {
  // The panels open and close on a spring (ui/spring-panels.ts).
  const layout = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (layout.current) return springPanels(layout.current);
  }, []);
  return (
    <>
      {header}
      <div className="chat-layout" ref={layout}>
        {main}
        {panels}
      </div>
    </>
  );
}
