export const artifactDownloadLimit = 10 * 1024 * 1024;

export function artifactDownloadError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(declined|unbound)\b/.test(message)) return null;
  if (/\btoo_large\b/.test(message))
    return "This artifact is too large to download.";
  if (/\bbusy\b/.test(message))
    return "Couldn’t download while a dialog is open. Close it and try again.";
  return "Couldn’t download this artifact. Try again.";
}
