/** Token-free UI invalidation after a confirmed GitHub connection change. */
export const githubConnectionChanged = "claudex:github-connection-changed";
export function notifyGitHubConnectionChanged() {
  window.dispatchEvent(new window.Event(githubConnectionChanged));
}
