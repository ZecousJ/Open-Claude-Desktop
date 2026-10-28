import { linearMcpUrl } from "../../shared/linear-api";
import type { EngineExtension } from "../engine/engine-extensions";

export function linearExtension(
  key: () => string,
  allowed: () => boolean,
): EngineExtension {
  return {
    id: "linear",
    reservedMcpServerNames: ["claudex_linear"],
    builtinMcpServers(ctx) {
      if (ctx.mode !== "code" || !allowed()) return undefined;
      const token = key();
      return token
        ? [
            {
              name: "claudex_linear",
              url: linearMcpUrl,
              httpHeaders: { Authorization: `Bearer ${token}` },
              defaultToolsApprovalMode: "prompt",
            },
          ]
        : undefined;
    },
  };
}
