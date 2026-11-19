const sessionPattern = /^(?:session|cse)_[a-f0-9]{32}$/;
type Search = {
  query: string;
  maxResults?: number;
  options?: { matchCase?: boolean; wholeWord?: boolean; regexp?: boolean };
};
type Params = Record<string, string | number | boolean | undefined>;
type RequestOptions = { signal?: AbortSignal };

export function createOfficialCodeWorkspace(input: {
  fetch: typeof fetch;
  organization: string;
  current: () => boolean;
  signal: AbortSignal;
}) {
  const sessionId = () =>
    /^\/code\/((?:session|cse)_[a-f0-9]{32})\/?$/.exec(location.pathname)?.[1];
  const matches = (session: unknown): session is string =>
    typeof session === "string" &&
    sessionPattern.test(session) &&
    sessionId()?.split("_")[1] === session.split("_")[1];
  const request = async (
    session: string,
    op: string,
    values: Params,
    options?: RequestOptions,
  ) => {
    if (!input.current() || !matches(session))
      throw Error("The Code workspace is unavailable.");
    const query = new URLSearchParams({ op });
    for (const [key, value] of Object.entries(values))
      if (value !== undefined) query.set(key, String(value));
    const response = await input.fetch(
      `/v1/code/sessions/${session}/workspace?${query}`,
      {
        headers: { "x-organization-uuid": input.organization },
        signal: options?.signal
          ? AbortSignal.any([input.signal, options.signal])
          : input.signal,
      },
    );
    if (!response.ok || !input.current())
      throw Error("The Code workspace could not be read.");
    return response.json();
  };
  const download = async (
    session: string,
    path: string,
    options?: RequestOptions,
  ) => {
    if (!input.current() || !matches(session))
      throw Error("The Code workspace is unavailable.");
    const response = await input.fetch(
      `/v1/code/sessions/${session}/file?${new URLSearchParams({ path })}`,
      {
        headers: { "x-organization-uuid": input.organization },
        signal: options?.signal
          ? AbortSignal.any([input.signal, options.signal])
          : input.signal,
      },
    );
    if (!response.ok || !input.current())
      throw Error("The Code workspace file could not be read.");
    return response.json();
  };
  return Object.freeze({
    sessionId,
    matches,
    list: (session: string, path: string, options?: RequestOptions) =>
      request(session, "list", { path }, options),
    read: (session: string, path: string) => request(session, "read", { path }),
    download,
    search: (session: string, { query, maxResults, options }: Search) =>
      request(session, "search", { query, maxResults, ...options }),
    async suggestions(session: string, query: string) {
      const files: { label: string; icon: string }[] = await request(
        session,
        "mentions",
        { query },
      );
      return files.map((file) => ({
        path: file.label + (file.icon === "directory" ? "/" : ""),
      }));
    },
    changes: (session: string, options: { context?: number } = {}) =>
      request(session, "changes", { context: options.context }),
  });
}
