import { Ghost } from "lucide-react";

/** The Chat home's incognito button (Lucide's ghost), 16px. */
export function IncognitoIcon() {
  return <Ghost size={16} strokeWidth={1.5} aria-hidden="true" />;
}

/** The incognito title bar's filled ghost, 16px. */
export function IncognitoSolidIcon() {
  return (
    <Ghost size={16} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
  );
}
