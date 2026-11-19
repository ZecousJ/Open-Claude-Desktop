export const supportBundleAsset = "cd53438bb-9zZS8-5X.js";
export const supportBundleLogMessage = "dKWJvS4l8G";
export const supportBundleLogLabel = "Recent error and warning log lines";

export function deriveSupportBundleCopy(source) {
  const categories = 'var D = ["system", "config", "reachability", "logs", "dmp"];';
  const logs = 'defaultMessage: "Recent log lines: errors, warnings, and app events",';
  if (!source.includes(categories) || !source.includes(logs))
    throw Error("Pinned diagnostic report copy did not match.");
  return source
    .replace(categories, 'var D = ["system", "logs"];')
    .replace(logs, `defaultMessage: "${supportBundleLogLabel}",`);
}
