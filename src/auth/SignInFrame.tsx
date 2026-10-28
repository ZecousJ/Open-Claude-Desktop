import { helpUrl } from "../../shared/help-links";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { signInFailed } from "../../shared/sign-in-errors";
import { WindowControls } from "../app/WindowControls";
import { formatText, t, useT } from "../i18n";
import { BusyLabel } from "./BusyLabel";
import { useTooltip } from "../ui/Tooltip";
import { KNOT_PATHS, KnotShape } from "../ui/Star";
import { reducedMotion } from "../ui/page-fade";
import { desktopPlatform } from "./desktopDownload";
import { welcome, welcomePlatform, type StatePage } from "./signInView";
import "./sign-in.css";
import { web, mac, LoginMethod } from "./signin-env";

/** The Claudex knot (the app icon's mark). */
function Star() {
  return (
    <svg
      className="signin-star"
      viewBox="120 120 784 784"
      aria-hidden="true"
      focusable="false"
    >
      <KnotShape cx={512} cy={512} size={784} stroke={60} />
    </svg>
  );
}

/**
 * The Claudex app icon (build/icon.svg, cropped to its rounded square): the
 * welcome screen shows it where the original shows its app icon.
 */
function AppIcon() {
  return (
    <svg
      className="signin-app-icon"
      viewBox="100 100 824 824"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="signin-app-icon-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#E4845F" />
          <stop offset="1" stopColor="#C2562F" />
        </linearGradient>
      </defs>
      <rect
        x="100"
        y="100"
        width="824"
        height="824"
        rx="186"
        fill="url(#signin-app-icon-fill)"
      />
      <g transform="translate(522 512) scale(0.82) translate(-522 -512)">
        {KNOT_PATHS.map((path) => (
          <path
            key={path}
            d={path}
            fill="none"
            stroke="#FFF7EE"
            strokeWidth="40"
            strokeLinejoin="round"
          />
        ))}
      </g>
    </svg>
  );
}

/**
 * The top of every signed-out page: the wordmark on the web; on the desktop
 * only the window's drag strip (and its buttons off macOS), as the
 * original's desktop sign-in has no wordmark.
 */
function FrameHeader() {
  return (
    <header className="signin-header">
      {web && (
        <span className="signin-brand">
          <Star />
          <span className="signin-wordmark">Claudex</span>
        </span>
      )}
      {!web && !mac && <WindowControls />}
    </header>
  );
}

const frameClass = `signin${web ? " signin-web" : " signin-desktop"}${mac ? " signin-mac" : ""}`;

/*
 * Motion, from claude.ai's own: the page rises in as its mobile menu's items do
 * (navbar-mobile-item-enter: 20px, 300ms, cubic-bezier(.22, 1, .36, 1), 40ms
 * apart; sign-in.css); a new step's heading and card content as a transcript
 * step does (cvc-tool-step-enter: 6px, --cds-dur-base 200ms, --cds-ease-out).
 */
const STEP_ENTER: Keyframe[] = [
  { opacity: 0, transform: "translateY(6px)" },
  { opacity: 1, transform: "none" },
];

const STEP_TIMING: KeyframeAnimationOptions = {
  duration: 200,
  easing: "cubic-bezier(.165, .84, .44, 1)",
};

/**
 * The frame every signed-out page shares: the Claudex wordmark in the
 * corner, a serif heading and subtitle, the card, and what goes below it.
 * `step` names what the card shows; when it changes (or the heading does)
 * the heading and the card's content rise in.
 */
export function SignInFrame({
  title,
  subtitle,
  children,
  lead,
  below,
  step,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** A line between the heading and the card. */
  lead?: ReactNode;
  below?: ReactNode;
  step?: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const key = `${step ?? ""}\u0000${title}`;
  const last = useRef(key);
  useLayoutEffect(() => {
    if (last.current === key) return;
    const headingChanged = !last.current.endsWith(`\u0000${title}`);
    last.current = key;
    const box = body.current;
    // The web login swaps its form in place; the desktop retains its step motion.
    if (web || !box || typeof box.animate !== "function" || reducedMotion())
      return;
    const moving = [
      ...(headingChanged
        ? box.querySelectorAll(
            ":scope > .signin-title, :scope > .signin-subtitle",
          )
        : []),
      ...box.querySelectorAll(":scope > .signin-card > *"),
    ];
    for (const element of moving) element.animate(STEP_ENTER, STEP_TIMING);
  }, [key]);
  return (
    <main className={frameClass}>
      <FrameHeader />
      <div className="signin-body" ref={body}>
        {/* The web's hero, or the desktop's short heading: its subtitle only on
           a state page. */}
        {title && <h1 className="signin-title">{title}</h1>}
        {subtitle && <p className="signin-subtitle">{subtitle}</p>}
        {lead}
        <section className="signin-card">{children}</section>
        {below}
      </div>
    </main>
  );
}

/**
 * The desktop's welcome screen: the app icon, "Claudex for Mac" with an italic
 * "for", one line under it, and "Get started" at the bottom of the window,
 * which opens the sign-in card.
 */
export function Welcome({ onNext }: { onNext: () => void }) {
  const t = useT();
  const platform = welcomePlatform(desktopPlatform(navigator));
  const title = t(welcome.title);
  // English sets "for" in italics, as the original does; a translation as is.
  const [before, after] =
    title === welcome.title ? ["Claudex ", " "] : [undefined, undefined];
  return (
    <main className={`${frameClass} signin-welcome`}>
      <FrameHeader />
      <div className="signin-body">
        <AppIcon />
        <h1 className="signin-welcome-title" data-no-translate>
          {before === undefined ? (
            formatText(welcome.title, { platform })
          ) : (
            <>
              {before}
              <em>for</em>
              {after}
              {platform}
            </>
          )}
        </h1>
        <p className="signin-welcome-tagline">{welcome.tagline}</p>
      </div>
      <div className="signin-welcome-actions">
        <button
          type="button"
          className="signin-primary"
          autoFocus
          onClick={onNext}
        >
          {welcome.action}
        </button>
      </div>
    </main>
  );
}

/** The window's error page (AuthGate's boundary): reload to start over. */
export function ErrorPage() {
  return (
    <SignInFrame
      title="Something went wrong"
      subtitle="Claudex ran into an unexpected problem."
    >
      <div className="signin-state" role="alert">
        <p className="signin-text">
          Reload to try again. Your conversations are saved.
        </p>
        <button
          type="button"
          className="signin-primary"
          onClick={() => location.reload()}
        >
          Reload
        </button>
      </div>
    </SignInFrame>
  );
}

/** A text button that reads as a link ("Try sending again"). */
export function TextLink({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="signin-link"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function StateCard({
  page,
  error,
  busy,
  onAction,
}: {
  page: StatePage;
  error?: string;
  busy?: boolean;
  onAction: () => void;
}) {
  return (
    <div className="signin-state" role="alert">
      {page.detail && <p className="signin-text">{page.detail}</p>}
      {error && (
        <p className="signin-error">
          {error === signInFailed ? <SignInFallback /> : error}
        </p>
      )}
      <button
        type="button"
        className="signin-primary"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={onAction}
      >
        <BusyLabel busy={Boolean(busy)} busyLabel="Please wait…">
          {page.action.label}
        </BusyLabel>
      </button>
    </div>
  );
}

export function SignInFallback() {
  const t = useT();
  const [before, after] = t(signInFailed).split("{emailSupport}");
  const [supportBefore, supportAfter] = t(
    "If the problem persists {link} for assistance.",
  ).split("{link}");
  return (
    <>
      {before}
      {supportBefore}
      <a
        className="signin-support"
        href={helpUrl("support")}
        target="_blank"
        rel="noreferrer"
      >
        {t("contact support")}
      </a>
      {supportAfter}
      {after}
    </>
  );
}

/** "Last used" beside the method this computer signed in with last time. */
export function LastUsed({
  method,
  last,
  children,
}: {
  method: LoginMethod;
  last: LoginMethod | undefined;
  children: ReactNode;
}) {
  const { props, tooltip } = useTooltip(t("Last used"), {
    placement: "left",
    disabled: method !== last,
  });
  if (method !== last) return <>{children}</>;
  return (
    <div className="signin-last-used" {...props}>
      {children}
      {tooltip}
    </div>
  );
}
