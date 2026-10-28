/** Connection notices. */
export type RemoteControlCause =
  "sign_in" | "update" | "network" | "process_stopped" | "retry";
export type RemoteControlNotice =
  | { kind: "on" }
  | { kind: "reconnect_failed" }
  | { kind: "connect_failed"; cause: RemoteControlCause; retries?: boolean }
  | { kind: "disconnect_failed"; cause: "retry" | "process_stopped" };

export function remoteControlCopy(notice: RemoteControlNotice) {
  if (notice.kind === "on")
    return { title: "Remote Control is on now.", warning: false };
  if (notice.kind === "reconnect_failed")
    return {
      title: "Remote Control is off",
      body: "It didn’t reconnect after the session was cleared. Turn it back on to keep using this session from your phone or the web.",
      warning: false,
    };
  if (notice.kind === "disconnect_failed")
    return notice.cause === "retry"
      ? {
          title: "Remote Control couldn’t turn off",
          body: "Try again in a moment.",
          warning: true,
        }
      : {
          title: "Remote Control is off",
          body: "Claudex Code stopped, so Remote Control turned off with it.",
          warning: false,
        };
  const bodies: Record<RemoteControlCause, string> = {
    sign_in: notice.retries
      ? "Sign in again. Remote Control retries with your next message."
      : "Sign in again, then turn on Remote Control.",
    update: "Update Claudex, then turn on Remote Control.",
    network:
      "Something on your network blocked Remote Control. Check your VPN or proxy, then try again.",
    process_stopped: notice.retries
      ? "Claudex Code stopped before Remote Control connected. Send a message to start it again, and Remote Control retries."
      : "Claudex Code stopped before Remote Control connected. Send a message to start it again, then turn on Remote Control.",
    retry: "Try again in a moment.",
  };
  return {
    title: "Remote Control couldn’t connect",
    body: bodies[notice.cause],
    warning: true,
  };
}
