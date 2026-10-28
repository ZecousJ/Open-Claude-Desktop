import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { WarningIcon } from "../policy/GlobalLimitToast";
import { isChunkLoadError } from "./load-failure";

const ChatLoadError = lazyPiece(
  () => import("./ChatLoadError"),
  "ChatLoadError",
);

/**
 * Keeps a page's rendering error inside the page: the sidebar and the rest of
 * the window stay usable and the page shows a danger banner, "Something went
 * wrong loading this page.", with Try again. A second failure, or a script that
 * did not load, offers Reload instead: trying again would only repeat it. Chat
 * and Code surfaces show the live conversation load state with a chat/session
 * headline, offline guidance, and Try again. Moving to another page or
 * conversation clears the error.
 */
export class PageBoundary extends Component<
  {
    /** A new page or conversation clears the error. */
    resetKey: string;
    /** The page is a Code session. */
    session?: boolean;
    /** The page is a chat or conversation surface. */
    chat?: boolean;
    children: ReactNode;
  },
  { failed: boolean; retried: boolean; chunk: boolean }
> {
  state = { failed: false, retried: false, chunk: false };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, chunk: isChunkLoadError(error) };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("The page failed to render:", error, info.componentStack);
  }
  componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false, retried: false, chunk: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    const reload = this.state.retried || this.state.chunk;
    const onAction = () =>
      reload
        ? location.reload()
        : this.setState({ failed: false, retried: true });
    if (this.props.chat || this.props.session)
      return (
        <Suspense fallback={null}>
          <ChatLoadError
            session={this.props.session === true}
            onRetry={onAction}
          />
        </Suspense>
      );
    return (
      <PageErrorBanner
        message="Something went wrong loading this page."
        action={reload ? "Reload" : "Try again"}
        onAction={onAction}
      />
    );
  }
}

/**
 * The original's danger banner in a padded box: a warning glyph, the
 * sentence, and a secondary button at its end. In the first-load bundle.
 */
export function PageErrorBanner({
  message,
  action,
  onAction,
}: {
  message: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="page-error">
      <div className="page-error-banner" role="alert">
        <WarningIcon />
        <span>{message}</span>
        <button type="button" onClick={onAction}>
          {action}
        </button>
      </div>
    </div>
  );
}
