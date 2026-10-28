/** The system file manager's name for Open in. */
export const fileManagerName = (platform: string) =>
  platform === "darwin"
    ? "Finder"
    : platform === "win32"
      ? "Explorer"
      : "File manager";
