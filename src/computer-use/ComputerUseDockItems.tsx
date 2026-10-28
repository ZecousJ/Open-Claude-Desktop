import { useState } from "react";
import type { ComputerUseActivity } from "../../shared/computer-use-api";
import { AccessCard } from "./AccessCard";
import { useComputerUse } from "./useComputerUse";

/** The strip's words while Claudex drives apps in this conversation. */
export function activityText(_activity: ComputerUseActivity) {
  return "Claudex is using your computer";
}

/**
 * Computer use above the open conversation's composer: its access requests
 * (after Codex's own requests) and, while Claudex is driving apps for it, a
 * line with Stop. Renders nothing otherwise.
 */
export function ComputerUseDockItems({
  conversationId,
  mac,
  frontmost,
  onError,
}: {
  conversationId: string;
  mac: boolean;
  /** No other request above takes the keyboard shortcuts. */
  frontmost: boolean;
  onError: (error: unknown) => void;
}) {
  const state = useComputerUse();
  const [stopping, setStopping] = useState(false);
  if (!state) return null;
  const requests = (state.requests ?? []).filter(
    (request) => request.conversationId === conversationId,
  );
  const activity =
    state.activity?.conversationId === conversationId
      ? state.activity
      : undefined;
  return (
    <>
      {activity && (
        <div className="cu-activity" data-mode={activity.mode}>
          <span className="cu-activity-dot" aria-hidden="true" />
          <span role="status" className="cu-activity-text">
            {activityText(activity)}
          </span>
          <button
            type="button"
            className="secondary cu-activity-stop"
            disabled={stopping}
            aria-busy={stopping || undefined}
            onClick={() => {
              setStopping(true);
              void window.desktop
                .stopComputerUse(conversationId)
                .catch(onError)
                .finally(() => setStopping(false));
            }}
          >
            Stop
          </button>
        </div>
      )}
      {requests.map((request, index) => (
        <AccessCard
          key={request.id}
          request={request}
          frontmost={frontmost && index === 0}
          mac={mac}
          canHideApps={Boolean(state.canHideApps)}
          background={state.settings.mode === "background"}
          unhide={state.settings.unhideApps}
          permissions={state.permissions}
          onError={onError}
        />
      ))}
    </>
  );
}
