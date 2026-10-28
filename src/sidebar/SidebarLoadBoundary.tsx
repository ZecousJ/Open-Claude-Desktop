import { Component, type ReactNode } from "react";
import { t } from "../i18n";
import "./sidebar-load-error.css";

/** Source shared-21-Cj1zQ-fC:7271–7294 contains a render-error fallback,
 * not a conversion of every request failure into an empty sidebar. */
export class SidebarLoadBoundary extends Component<
  {
    scope: unknown;
    onError?(error: unknown): void;
    children?: ReactNode;
  },
  { failed: boolean; scope: unknown }
> {
  state = { failed: false, scope: this.props.scope };
  static getDerivedStateFromProps(
    props: { scope: unknown },
    state: { scope: unknown },
  ) {
    return props.scope === state.scope
      ? null
      : { failed: false, scope: props.scope };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("Sidebar failed to render:", error);
    this.props.onError?.(error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="sidebar-load-error" role="alert">
        <p>{t("Sidebar failed to load.")}</p>
        <button
          type="button"
          className="small-action"
          onClick={() => this.setState({ failed: false })}
        >
          {t("Try again")}
        </button>
      </div>
    );
  }
}
