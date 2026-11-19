import type { AdapterContext } from "./api/context";

/** The native host outlives account windows; command authority follows the active window. */
export function bindNativeCommandContext(
  context: AdapterContext,
  current: () => AdapterContext["codeCommandPermissions"],
): AdapterContext {
  Object.defineProperty(context, "codeCommandPermissions", { get: current, enumerable: true });
  return context;
}
