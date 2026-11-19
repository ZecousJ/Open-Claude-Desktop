import type { ReactNode } from "react";

// Hand-drawn approximations of Claude's filled Cowork idea illustrations, traced from
// claude-cowork-home-main-001-ideas-crop.png on a 28 × 28 box centered on each row.
function Frame({ children }: { children: ReactNode }) {
  return (
    <svg
      className="cowork-idea-icon"
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Hand-written text drawn as a small zigzag between x0 and x1 at height y. */
function Scribble({ x0, x1, y }: { x0: number; x1: number; y: number }) {
  const points: string[] = [];
  for (let x = x0, up = true; x <= x1 + 0.01; x += 0.75, up = !up)
    points.push(`${x.toFixed(2)},${(y + (up ? -0.45 : 0.45)).toFixed(2)}`);
  return (
    <polyline className="idea-ink" points={points.join(" ")} strokeWidth=".7" />
  );
}

export function BriefingIdeaIcon() {
  return (
    <Frame>
      <rect
        className="idea-line"
        x="2.5"
        y="2.5"
        width="23"
        height="23"
        rx="2.75"
        strokeWidth="1"
      />
      <path
        className="idea-soft"
        d="M14 6.9v1.5M6.75 9.25l1.5 1.5M21.25 9.25l-1.5 1.5M5.25 14h1.5M21.25 14h1.5"
        strokeWidth="1"
      />
      <path
        className="idea-fill idea-edge"
        d="M8.75 16.75V15.5a5.25 5.25 0 0 1 10.5 0v1.25Z"
        strokeWidth=".6"
      />
      <path className="idea-line" d="M4.75 17.25h17.5" strokeWidth="1" />
      <path className="idea-faint" d="M7.75 20.5h13" strokeWidth="1" />
    </Frame>
  );
}

export function InboxIdeaIcon() {
  return (
    <Frame>
      <path
        className="idea-line"
        d="M.25 15.25 2.75 12.5V8.75c0-1.1.9-2 2-2H20.4c1.1 0 2 .9 2 2v4.5c0 1.1-.9 2-2 2Z"
        strokeWidth="1"
      />
      <Scribble x0={5} x1={9.25} y={11} />
      <Scribble x0={11} x1={14.75} y={11} />
      <Scribble x0={16} x1={20} y={11} />
      <path
        className="idea-line idea-cutout"
        d="M13.25 13.9h10c1.1 0 2 .9 2 2v3.6l2.75 2.4-3.5-.9-.75.25c-.3.6-.9.9-1.5.9H13.25c-1.1 0-2-.9-2-2v-4.25c0-1.1.9-2 2-2Z"
        strokeWidth="1"
      />
      <Scribble x0={14.5} x1={22} y={18} />
    </Frame>
  );
}

export function CustomizeIdeaIcon() {
  return (
    <Frame>
      <path
        className="idea-line"
        d="M2 4c0-1.1.9-2 2-2h17.5l4.25 4.75V24.25c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2Z"
        strokeWidth="1"
      />
      <path className="idea-line" d="M20.25 2.25v5h5.25" strokeWidth="1" />
      <path
        className="idea-fill"
        d="M4.75 4h15v3.75h4v7.5c0 .45-.35.75-.75.75H4.75c-.45 0-.75-.3-.75-.75V4.75c0-.45.3-.75.75-.75Z"
      />
      <Scribble x0={6} x1={14} y={7.25} />
      <Scribble x0={6.5} x1={20.5} y={10.5} />
      <Scribble x0={5} x1={22.5} y={13.5} />
      <path
        className="idea-line"
        d="M9.4 18v3H2.75M5 18.75 2.75 21 5 23.25"
        strokeWidth="1.1"
      />
    </Frame>
  );
}

// The live Cowork suggestions' folder and file thumbnails (live claude.ai
// bundle, 2026-10-12: a folder whose tinted back tab shows over a front
// pocket; a page of handwriting over a small table with a tinted header
// row), redrawn on the same 28 × 28 box as the three above.
export function OrganizeIdeaIcon() {
  return (
    <Frame>
      <path
        className="idea-fill idea-line"
        d="M4.6 4.5h6.6c.45 0 .9.2 1.2.5l.55.55c.5.5 1.15.75 1.8.75H24c.9 0 1.6.7 1.6 1.6v2.45c0 .9-.7 1.6-1.6 1.6H4.6c-.9 0-1.6-.7-1.6-1.6V6.1c0-.9.7-1.6 1.6-1.6Z"
        strokeWidth="1"
      />
      <rect
        className="idea-line idea-cutout"
        x="2.5"
        y="8.45"
        width="23"
        height="15.05"
        rx="3.2"
        strokeWidth="1"
      />
    </Frame>
  );
}

export function FileIdeaIcon() {
  return (
    <Frame>
      <rect
        className="idea-line"
        x="2.5"
        y="2.5"
        width="23"
        height="23"
        rx="2.75"
        strokeWidth="1"
      />
      <Scribble x0={6} x1={10.5} y={6.9} />
      <Scribble x0={11.75} x1={16} y={6.9} />
      <Scribble x0={17.25} x1={21.5} y={6.9} />
      <Scribble x0={6} x1={18.5} y={9.2} />
      <path
        className="idea-fill"
        d="M5.8 14.5c0-.55.45-1 1-1h14.4c.55 0 1 .45 1 1v1.8H5.8Z"
      />
      <rect
        className="idea-line"
        x="5.8"
        y="13.5"
        width="16.4"
        height="8.7"
        rx=".5"
        strokeWidth=".7"
      />
      <path
        className="idea-edge"
        d="M5.8 16.3h16.4M5.8 19.4h16.4M14 13.5v8.7"
        strokeWidth=".5"
      />
    </Frame>
  );
}
