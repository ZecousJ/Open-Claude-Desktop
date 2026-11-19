/** Hand-drawn ghost for the Chat home incognito button: a wide dome with a three-arch hem, traced from
    claude-chat-home-main-001.png (15.5 × 15.5px glyph, eyes 6px apart). */
export function IncognitoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="-.25 -.25 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M.65 14.85V7.3a7.1 7.1 0 0 1 14.2 0v7.55Q12.48 11 10.12 14.85 7.75 11 5.38 14.85 3.02 11 .65 14.85Z" />
      <circle cx="5" cy="7.75" r=".45" fill="currentColor" />
      <circle cx="10.5" cy="7.75" r=".45" fill="currentColor" />
    </svg>
  );
}

/** Solid ghost before "Incognito chat" in the incognito title bar, traced from the R-0003 captures:
    16 × 15.75px, eye holes 6px apart, four hem points with three arches between them. */
export function IncognitoSolidIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
    >
      <path d="M.25 8a7.75 7.75 0 0 1 15.5 0v7.75Q13.2 12.8 10.6 15.75 8 12.8 5.4 15.75 2.8 12.8.25 15.75ZM4.2 7.5h1.5v2H4.2ZM10.3 7.5h1.5v2h-1.5Z" />
    </svg>
  );
}
