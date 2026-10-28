import "./bash-mode.css";

/** Bash mode's marker beside Send; it loads with the mode. */
export function BashModePill() {
  return (
    <span
      className="bash-mode-pill"
      aria-hidden="true"
      title="Run as a shell command"
    >
      bash
    </span>
  );
}
