/**
 * The Workflow tool's description: what the model reads to write a script
 * (after the official Workflow tool and its workflow-authoring reference,
 * Claude Code), with the session's size guideline.
 */
export const workflowToolName = "Workflow";

export type WorkflowSize = "small" | "medium" | "large" | "unrestricted";
export const workflowSizes: readonly WorkflowSize[] = [
  "small",
  "medium",
  "large",
  "unrestricted",
];
/** The agent counts behind each guideline (the official setting's text). */
export const workflowSizeLimits: Record<WorkflowSize, number | undefined> = {
  small: 5,
  medium: 10,
  large: 50,
  unrestricted: undefined,
};

function sizeLine(size: WorkflowSize) {
  const limit = workflowSizeLimits[size];
  return limit
    ? `This session's workflow size guideline is ${size}: keep a workflow under ${limit} agents unless the user asks for a different scale.`
    : "This session has no workflow size guideline; scale the workflow to the task.";
}

export function workflowToolDescription(size: WorkflowSize) {
  return `Run a workflow script that orchestrates many subagents deterministically: fan a task out to parallel agents, verify findings adversarially, sweep a codebase, migrate many files. Each agent is a fresh agent with this session's model, folder and sandbox; it does not see this conversation, so give each prompt everything it needs.

ONLY use this tool when the user opted into multi-agent orchestration for this turn. The turn's instructions may say Ultracode is on, or the user may ask to run a workflow, use many agents, fan out, or run a named workflow. A workflow can use many times the tokens of a normal turn. Otherwise do the work yourself, or describe what a workflow would do and ask.
${sizeLine(size)}

The script is plain JavaScript (no TypeScript, no imports). It must begin with a pure-literal meta:
  export const meta = {
    name: 'review-changes',
    description: 'Review the diff across dimensions and verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify', detail: 'one skeptic per finding' }],
  }
then the body, which runs as an async function (use await; \`return\` gives the result back to you).

Hooks:
- agent(prompt, opts?) → the agent's final text, or with opts.schema (a JSON Schema object) the parsed object. null when the agent failed. opts: label (shown in the progress view), phase (group it explicitly; use inside parallel/pipeline), schema, model (a model id of this session; omit to inherit), effort ('low' | 'medium' | 'high' | 'xhigh'), isolation: 'worktree' (its own git worktree, only when agents edit files in parallel; removed if unchanged; in the desktop app only, elsewhere the agent shares the folder).
- parallel(thunks) → runs functions concurrently and waits for all (a barrier); a failing thunk gives null.
- pipeline(items, stage1, stage2, ...) → each item flows through all stages independently with no barrier between stages; stage(prev, item, index). Prefer pipeline for multi-stage work.
- phase(title) starts a progress group; log(message) shows a progress line.
- args is the tool's args input; workflow(name, args) runs a saved workflow inline (one level).
- Date.now(), new Date() without arguments and Math.random() throw (they would break resume). No require, process, fs or network: agents do the reading and writing.

Agents run up to 16 at a time, at most 1000 per run. An agent's final message is its return value: ask for raw data, not a report for a person. Use schema whenever later code reads the result. Filter nulls (.filter(Boolean)) before using results.

Patterns: adversarial verify (several skeptics per claim, keep it only if most fail to refute it), perspective-diverse review (one lens per agent), loop until dry for open-ended discovery, a completeness critic at the end. Log what you leave out instead of truncating silently.

Inputs: script (inline), or name (a saved workflow: .claude/workflows/<name>.js in the project or ~/.claude/workflows), or scriptPath (a script file; every run saves its script and gives you the path, so edit that file and pass scriptPath to iterate). args is passed to the script verbatim (pass arrays/objects, not JSON strings). resumeFromRunId replays the finished agents of an earlier run with the same prompts and options and runs the rest. The tool returns when the workflow ends, with the script's return value.`;
}

/** JSON Schema of the tool's input. */
export const workflowToolInput = {
  type: "object",
  properties: {
    script: {
      type: "string",
      description:
        "The workflow script: `export const meta = {...}` then the body.",
    },
    name: {
      type: "string",
      description: "A saved workflow to run (.claude/workflows/<name>.js).",
    },
    scriptPath: {
      type: "string",
      description: "A script file to run (a saved run's script, edited).",
    },
    args: {
      description: "Passed to the script as `args`, verbatim.",
    },
    resumeFromRunId: {
      type: "string",
      description:
        "An earlier run of this session whose finished agents are replayed.",
    },
  },
  additionalProperties: false,
};
