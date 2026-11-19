/** Final outbound effort semantics from trusted cached account catalog only. */
import type { GatewayModelEfforts } from "../../shared/gateway-signals";
import { validGatewayEfforts } from "../../shared/gateway-signals";
export function applyGatewayEffort(
  request: Record<string, any>,
  contracts?: readonly GatewayModelEfforts[],
) {
  const entries = contracts?.filter((item) => item.model === request.model);
  if (
    !entries ||
    entries.length !== 1 ||
    !validGatewayEfforts(entries[0].efforts)
  )
    return request;
  const allowed = entries[0].efforts;
  const reasoning = request.reasoning;
  const nested =
    reasoning && typeof reasoning === "object" && !Array.isArray(reasoning);
  if (allowed.length === 0) {
    const { reasoning_effort: _legacy, ...out } = request;
    if (nested && Object.hasOwn(reasoning, "effort")) {
      const { effort: _effort, ...rest } = reasoning;
      if (Object.keys(rest).length) out.reasoning = rest;
      else delete out.reasoning;
    }
    return out;
  }
  for (const effort of [
    nested ? reasoning.effort : undefined,
    request.reasoning_effort,
  ])
    if (
      effort !== undefined &&
      (typeof effort !== "string" || !allowed.includes(effort))
    )
      throw Error(
        "The requested reasoning effort is not supported by this model.",
      );
  return request;
}
