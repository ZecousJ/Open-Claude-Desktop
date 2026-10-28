import {
  codeSandboxFor,
  scheduledCodeSandbox,
  taskSandboxFor,
} from "../../shared/sandbox-policy";
import {
  chatExecutionEnabled,
  chatArtifactsEnabled,
} from "../../shared/chat-execution";
import { preference, type TaskPermission } from "../../shared/settings-extras";
import type { Mode, Settings } from "../../shared/types";

export function modeInstructions(mode: Mode, settings?: Settings) {
  if (mode === "chat" && settings && !chatExecutionEnabled(settings, mode))
    return chatArtifactsEnabled(settings)
      ? "You are a thoughtful conversational assistant. Code execution, local file creation and skills are off for Chat. Answer directly; for an artifact, provide its content in a fenced code block. Do not execute code or create files."
      : "You are a thoughtful conversational assistant. Code execution, local file creation, skills and artifacts are off for Chat. Answer directly in the conversation. Do not execute code or create files.";
  if (mode === "chat")
    return [
      "You are a thoughtful conversational assistant. Answer directly.",
      "When the user asks for something substantial and self-contained that they will view or use on its own — a web page or small app (HTML), an SVG graphic, a React component, a Markdown document, a diagram, or a file such as a spreadsheet, slides or a PDF — create it as a new file in the current working directory with your file tools (apply_patch for text files) instead of writing its contents in the reply. Name the file after what it is, for example pelican-bike.html. The app shows every file you create as an artifact beside the conversation, so afterwards reply briefly with what you made and how to use it, without repeating its contents. To change an artifact, edit that same file.",
      "HTML and React artifacts run in a sandbox without network access: inline every script, style and piece of data and load nothing from the internet.",
      "Keep short code snippets, examples and explanations in the reply. Run commands only when the task needs them, and do not change other files on the computer unless the user asks for a local action.",
      "The working directory is a scratch folder for what you make; do not search it for instructions or earlier work unless the user refers to it. Start with the substance, without announcing what you are about to do. Do not link to files you created: the artifact card already opens them.",
    ].join(" ");
  if (mode === "cowork")
    return "You are a collaborative desktop assistant. Help the user complete work in their selected folder, explain meaningful progress, and produce useful files.";
  return "You are a coding assistant. Inspect the workspace, make requested changes, and verify them.";
}

/** Settings → Capabilities, told to Chat's model when switched on. */
export function capabilityInstructions(settings: Settings, mode: Mode) {
  if (mode !== "chat") return [];
  return [
    preference(settings, "inlineVisualizations") &&
      "Inline visualizations are on: when a chart, diagram or small interactive widget would genuinely help, put a self-contained HTML fragment or an SVG in a fenced code block whose language is `visualization`. It is drawn in place in the reply, in a sandbox without network access, so inline every script, style and piece of data and load nothing from the internet. Keep it compact, leave the background transparent and use colours that read on light and dark backgrounds.",
    chatArtifactsEnabled(settings) &&
      preference(settings, "aiArtifacts") &&
      "AI-powered artifacts are on: an HTML or React artifact may call `await window.claude.complete(prompt)`, which resolves with the model's answer as a string. Calls share no history, so put all the context a call needs in its prompt. Use it only when the artifact itself needs AI.",
    Object.values(settings.mcpServers ?? {}).some(
      (server) =>
        server &&
        typeof server === "object" &&
        (server as Record<string, unknown>).enabled !== false,
    ) &&
      "HTML and React artifacts can use the account's configured connectors through window.claude.mcp (also window.mcp). await mcp.listTools() returns {servers:[{server,tools:[{name,description,inputSchema}]}]}; await mcp.callTool(server, tool, input) returns the MCP tool result. The viewer must approve tools before their first use in each artifact and can revoke access in its Permissions. If an artifact needs a known set of tools, pass {groups:[{server,tools:[toolName,...]}]} as the fourth callTool argument to review that set together. Never embed connector tokens or make direct network requests from the artifact.",
  ].filter((line): line is string => Boolean(line));
}

/** The sandbox chosen for this mode and folder before platform policy applies. */
export function chosenSandbox(
  settings: Settings,
  mode: Mode,
  cwd?: string,
  scheduledRun = false,
  asksFirst = false,
  scheduledPermission?: TaskPermission,
) {
  // Both stored non-Code kinds use the unified Manual / Auto picker;
  // a scheduled run follows
  // the permission its routine was saved with (full access when it has none);
  // a task from an outside prompt asks first.
  if (mode !== "code")
    return taskSandboxFor(
      settings,
      scheduledRun,
      asksFirst,
      scheduledPermission,
    );
  // A Code routine saved with a mode uses it; without one it follows Code.
  if (scheduledRun) {
    const scheduled = scheduledCodeSandbox(settings, scheduledPermission, cwd);
    if (scheduled) return scheduled;
  }
  return codeSandboxFor(settings, cwd);
}
