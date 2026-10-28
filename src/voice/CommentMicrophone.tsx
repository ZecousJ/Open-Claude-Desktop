import { Mic } from "lucide-react";

export function CommentMicrophone({ recording }: { recording: boolean }) {
  return (
    <Mic
      className="app-icon"
      size={16}
      strokeWidth={1.75}
      fill={recording ? "currentColor" : "none"}
      aria-hidden="true"
    />
  );
}
