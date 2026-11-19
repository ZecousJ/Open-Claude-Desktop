import type { ClientPolicy } from "./client-policy";

// (live claude.ai bundle, 2026-10-14, c71860c77-xHdlpCO8)
export function extensionPolicyNotice(
  policy: Pick<
    ClientPolicy,
    "desktopExtensionsEnabled" | "developerMcpEnabled"
  >,
) {
  if (
    policy.desktopExtensionsEnabled === false &&
    policy.developerMcpEnabled === false
  )
    return "Desktop extensions and developer MCP servers are disabled on this device. Please contact your IT administrator to enable these features.";
  if (policy.desktopExtensionsEnabled === false)
    return "Desktop extensions are disabled on this device. Please contact your IT administrator to enable desktop extensions.";
  if (policy.developerMcpEnabled === false)
    return "Developer MCP servers are disabled on this device. Please contact your IT administrator to enable developer MCP servers.";
}
