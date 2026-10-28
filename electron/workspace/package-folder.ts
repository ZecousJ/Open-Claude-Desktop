/**
 * macOS packages are folders that Finder opens as one item: opening an .app
 * bundle launches it. Open in reveals these instead of opening them.
 */
const packageExtensions =
  /\.(app|bundle|framework|plugin|kext|pkg|mpkg|prefpane|appex|xpc)$/i;

export const isPackageFolder = (folder: string) =>
  packageExtensions.test(folder.replace(/[\\/]+$/, ""));
