/**
 * Open Computer Use 0.3.5 (MIT, docs/computer-use.md): the pinned driver.
 * Its nine tools take `app` as a name, bundle id (macOS) or process id
 * (Windows); the broker always passes the exact target it resolved.
 */
import type {
  ComputerUseContent,
  ComputerUseToolResult,
} from "../../../shared/computer-use";
import type {
  ComputerDriver,
  DriverApp,
  DriverHost,
  DriverMode,
} from "../driver-host";

/** The driver's own tools (drivers.json `tools`). */
export const openComputerUseTools = [
  "list_apps",
  "get_app_state",
  "click",
  "perform_secondary_action",
  "scroll",
  "drag",
  "type_text",
  "press_key",
  "set_value",
] as const;

/**
 * Parses `list_apps` text. macOS lines read
 * `Name — com.example.App [running, frontmost, last-used=…, uses=…]`,
 * Windows lines `notepad -- notepad [running, pid=1234, window=Title]`.
 */
export function parseAppList(text: string): DriverApp[] {
  const apps: DriverApp[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(.+?) (?:—|--) (\S+)(?: \[(.*)\])?\s*$/.exec(line.trim());
    if (!match) continue;
    const flags = (match[3] ?? "").split(",").map((flag) => flag.trim());
    const pid = flags
      .map((flag) => /^pid=(\d+)$/.exec(flag)?.[1])
      .find(Boolean);
    apps.push({
      name: match[1].trim(),
      id: match[2],
      ...(pid ? { pid: Number(pid) } : {}),
      running: flags.includes("running"),
      frontmost: flags.includes("frontmost"),
    });
  }
  return apps;
}

/** Keeps only the content kinds Claudex passes on (text and images). */
export function normalizeResult(result: any): ComputerUseToolResult {
  const content: ComputerUseContent[] = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === "text" && typeof item.text === "string")
      content.push({ type: "text", text: item.text });
    else if (
      item?.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    )
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
  }
  return { content, ...(result?.isError ? { isError: true } : {}) };
}

export class OpenComputerUseDriver implements ComputerDriver {
  constructor(
    private host: DriverHost,
    private onAccessibilityDenied?: () => void,
  ) {}

  async listApps(mode: DriverMode): Promise<DriverApp[]> {
    const result = normalizeResult(
      await this.host.request(
        "tools/call",
        { name: "list_apps", arguments: {} },
        mode,
      ),
    );
    if (result.isError)
      throw new Error(
        result.content.find((item) => item.type === "text")?.text ??
          "The computer use driver couldn't list apps.",
      );
    return parseAppList(
      result.content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("\n"),
    );
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    mode: DriverMode,
  ): Promise<ComputerUseToolResult> {
    if (!(openComputerUseTools as readonly string[]).includes(tool))
      throw new Error(`The driver has no ${tool} tool.`);
    const result = normalizeResult(
      await this.host.request(
        "tools/call",
        { name: tool, arguments: args },
        mode,
      ),
    );
    // A process that was refused may retain its old Accessibility state after approval.
    if (result.isError && result.content.some(
      item => item.type === "text" &&
        item.text.startsWith("Accessibility permission is required."),
    )) {
      this.onAccessibilityDenied?.();
      await this.host.stop();
      return {
        isError: true,
        content: [{
          type: "text",
          text: "macOS denied Accessibility for Open Computer Use. In Claudex, go to Settings → System → Computer use and choose Open System Settings beside Accessibility. That opens the installed driver's permission guide. Ask the person to finish granting access before retrying.",
        }],
      };
    }
    return result;
  }

  stop() {
    return this.host.stop();
  }
}
