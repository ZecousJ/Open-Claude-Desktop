const projectPlace = (path: string) =>
  path === "/projects" ||
  path === "/cowork/projects" ||
  /^\/(?:cowork\/)?project\/[^/]+$/.test(path);
const collection = (path: string) =>
  projectPlace(path)
    ? "projects"
    : path === "/artifacts"
      ? "artifacts"
      : undefined;

/**
 * Project list filters own their query state. The app's route synchronizer owns
 * the place and Settings destination only.
 */
export function withProjectQuery(
  target: string | undefined,
  current: { pathname: string; search: string } | undefined,
) {
  if (!target || !current || !collection(current.pathname)) return target;
  const next = new URL(target, "http://route.invalid");
  if (collection(next.pathname) !== collection(current.pathname)) return target;
  const params = new URLSearchParams(current.search);
  // This is the router's Settings parameter, not a project-list filter.
  params.delete("connector");
  // Code is a route surface, not a sticky gallery filter. Closing Code or
  // Settings must not resurrect the previous route-owned value.
  if (collection(next.pathname) === "artifacts") params.delete("surface");
  for (const key of new Set(next.searchParams.keys())) params.delete(key);
  for (const [key, value] of next.searchParams) params.append(key, value);
  const query = params.toString();
  return `${next.pathname}${query ? `?${query}` : ""}${next.hash}`;
}
