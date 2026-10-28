import type { HostInfo } from "../../shared/host";
import type { Mode } from "../../shared/types";

/**
 * Whether a Code composer takes the live layout: "+" and the microphone inside
 * the 44px frame, and under it the permission mode, the model with its effort
 * in one button and the 24px usage ring. Every Code home has it; on the web an
 * opened session has it too (the live session composer is the home's without
 * the place row).
 */
export function codeLiveLayout(
  mode: Mode,
  host: Pick<HostInfo, "kind">,
  codeHomeDraft: boolean,
): boolean {
  return codeHomeDraft || (mode === "code" && host.kind === "web");
}
