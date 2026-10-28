import type { SVGProps } from "react";
import { Maximize2, X } from "../ui/glyphs";
import { IconButton } from "../ui/Controls";

/**
 * A window with a smaller panel in its lower-left corner: the expanded Artifact
 * header's Pop out chat.
 */
export function PopOutChatIcon({
  size = 16,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M4 13h6a1 1 0 0 1 1 1v6" />
    </svg>
  );
}

/**
 * The frame of the conversation floating over an expanded Artifact: a card in
 * the lower-left corner of the window with Expand chat (back to the
 * conversation beside the Artifact) and Close chat (the Artifact stays full
 * size). The conversation inside is the page's own transcript and composer,
 * which floating-chat-panel.css lifts into this card while the Artifact panel
 * carries `data-chat-float`, so a message typed here is the same draft and goes
 * to the same conversation as in the split view. It is one window: nothing
 * opens outside it.
 */
export function FloatingChatPanel({
  onDock,
  onClose,
}: {
  onDock: () => void;
  onClose: () => void;
}) {
  return (
    <div className="floating-chat-frame" data-testid="floating-chat">
      <div className="floating-chat-controls">
        <IconButton label="Expand chat" onClick={onDock}>
          <Maximize2 size={15} />
        </IconButton>
        <IconButton label="Close chat" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
    </div>
  );
}
