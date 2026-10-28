import { Component, type ErrorInfo, type ReactNode } from "react";
import { X } from "../ui/glyphs";
import { IconButton } from "../ui/Controls";

/**
 * Keeps a side panel's rendering error inside the panel: the conversation
 * and the rest of the window stay usable, and the panel can be tried again
 * or closed. Renders its children unchanged while nothing fails.
 */
export class PanelBoundary extends Component<
  {
    /** A new panel or conversation clears the error. */
    resetKey: string;
    onClose: () => void;
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Panel failed to render:", error, info.componentStack);
  }
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <aside className="work-panel" role="alert">
        <header>
          <strong>This panel couldn't be shown</strong>
          <IconButton label="Close panel" onClick={this.props.onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className="work-panel-content">
          <div className="panel-empty">
            <p>Something went wrong while showing it.</p>
            <button
              className="small-action"
              onClick={() => this.setState({ failed: false })}
            >
              Try again
            </button>
          </div>
        </div>
      </aside>
    );
  }
}
