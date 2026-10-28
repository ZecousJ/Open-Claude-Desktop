import type { Item } from "../../../shared/types";
import { formatText } from "../../i18n";

/** Running tool copy. */
const labels: Record<string, string> = {
  Glob: "Looking for files…",
  Grep: "Searching files…",
  Read: "Reading a file…",
  Write: "Creating a file…",
  Edit: "Editing a file…",
  MultiEdit: "Editing files…",
  Bash: "Running a command…",
  PowerShell: "Running a command…",
  WebFetch: "Reading a page…",
  WebSearch: "Searching the web…",
  Agent: "Multitasking…",
  Task: "Multitasking…",
  SendMessage: "Multitasking…",
  TaskGet: "Reading task…",
  TaskList: "Listing tasks…",
  TaskCreate: "Updating tasks…",
  TaskUpdate: "Updating tasks…",
  TaskStop: "Updating tasks…",
  TodoWrite: "Updating the plan…",
  ToolSearch: "Loading tools…",
  AskUserQuestion: "Asking a question…",
  Skill: "Using a skill…",
  SendUserMessage: "Sending message…",
  SendUserFile: "Sharing files…",
  PushNotification: "Sending notification…",
  FetchInboxMessage: "Reading the thread…",
  BashOutput: "Checking command output…",
  KillBash: "Stopping a command…",
  LS: "Listing files…",
  NotebookEdit: "Editing notebook…",
  EnterPlanMode: "Starting a plan…",
  ExitPlanMode: "Proposing a plan…",
  Workflow: "Running workflow…",
  REPL: "Running code…",
  JavaScript: "Running code…",
  AppifactRepl: "Running code…",
  Poll: "Waiting for results…",
  Tmux: "Running terminal…",
};

const aliases: Record<string, string> = {
  exec_command: "Bash",
  write_stdin: "BashOutput",
  spawn_agent: "Agent",
  spawnAgent: "Agent",
  resumeAgent: "Agent",
  resume_agent: "Agent",
  send_input: "SendMessage",
  sendInput: "SendMessage",
  wait_agent: "Poll",
  update_plan: "TodoWrite",
  request_user_input: "AskUserQuestion",
  list_mcp_resources: "LS",
  read_mcp_resource: "Read",
  js: "JavaScript",
};

export function toolRunningLabel(item: Item) {
  const toolName = item.tool?.trim();
  if (!toolName) return "Using a tool";
  const name = toolName.split(/__|\./).at(-1)!;
  const kind = aliases[name] ?? name;
  const input = item.arguments ?? item.input;
  const path =
    input && typeof input === "object" && "file_path" in input
      ? input.file_path
      : undefined;
  if (
    typeof path === "string" &&
    ["Read", "Write", "Edit", "MultiEdit"].includes(kind)
  ) {
    const fileName = path.split(/[\\/]/).at(-1) ?? path;
    return formatText(
      kind === "Read"
        ? "Reading {fileName}…"
        : kind === "Write"
          ? "Creating {fileName}…"
          : "Editing {fileName}…",
      { fileName },
    );
  }
  return labels[kind] ?? formatText("Using {toolName}…", { toolName });
}
