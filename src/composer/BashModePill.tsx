import "./bash-mode.css";

/**
 * Bash mode's marker beside Send (desktop bundle 2.31226.1: a small "bash"
 * pill titled "Run as a shell command"); it loads with the mode.
 */
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
