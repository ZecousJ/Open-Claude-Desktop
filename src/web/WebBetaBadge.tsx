/**
 * "Beta" at the top right of the web app's home (W-UI-design §4.1,
 * ref-web-chat-home). A label, not a control. Shown on the Cowork home,
 * as claude.ai does; its Chat home has none.
 */
export function WebBetaBadge() {
  return (
    <span className="web-beta-badge" role="note">
      Beta
    </span>
  );
}
