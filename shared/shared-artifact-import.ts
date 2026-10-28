export function sharedArtifactToken(value: string): string | undefined {
  const token = /^[A-Za-z0-9_-]{20,64}$/;
  if (token.test(value.trim())) return value.trim();
  try {
    const url = new URL(value);
    if (
      !["https:", "http:", "claudex:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return;
    const candidate =
      url.protocol === "claudex:"
        ? url.host === "cowork" && url.pathname === "/shared-artifact"
          ? url.searchParams.get("token")
          : null
        : /^\/(?:s|shared)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
    return candidate && token.test(candidate) ? candidate : undefined;
  } catch {
    return;
  }
}
