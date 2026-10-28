/**
 * What the model says a shell command does (R7): the gateway adds a
 * `description` parameter to Codex's shell tools and reads it back from the
 * model's function call. The text is stored as `Item.description` on the
 * matching `commandExecution` item (item id = the call's `call_id`).
 *
 * `Item.description` is model output: already cleaned by
 * `sanitizeDescription`, at most `maxDescriptionLength` code points, only on
 * command items, and rendered as plain text. It never feeds an approval,
 * permission or policy decision. Package R7-C adds the running / completed /
 * failed wording (`describeCommand`, `pastTense`) to this file.
 */

/** Codex's function tools that run a shell command and so get a description. */
export const describedShellTools: ReadonlySet<string> = new Set([
  "exec_command",
  "shell_command",
  "shell",
]);

/** Longest description kept, in code points. */
export const maxDescriptionLength = 160;

/** The `description` parameter added to a shell tool's JSON schema. */
export const descriptionParameter = Object.freeze({
  type: "string",
  description:
    'Clear, concise description of what this command does, in 5-10 words, imperative mood (e.g. "List repository files", "Run the unit tests"). Shown to the user as the title of this step; write it in the user\'s language.',
});

/** The developer-instruction line that backs the schema change up. */
export const describeToolsInstruction =
  "Every shell command call must include a short description (5-10 words, imperative) of what it does.";

/** A description read from a shell tool call, as the gateway reports it. */
export interface ToolDescriptionEvent {
  /** The Codex thread that made the request (`client_metadata.thread_id`). */
  threadId: string;
  /** The function call's `call_id`, which is the command item's id. */
  callId: string;
  description: string;
}

// C0 and C1 controls, bidi embeddings, overrides and isolates, zero-width
// characters and the byte order mark: anything that could hide or reorder
// the visible text of a row.
const invisible =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const loneSurrogate =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * The description as shown: control, bidi and zero-width characters removed,
 * whitespace folded to single spaces, cut to `maxDescriptionLength` code
 * points (never inside a surrogate pair). undefined when nothing is left.
 */
export function sanitizeDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const folded = value
    .slice(0, 4 * maxDescriptionLength + 64)
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, " ")
    .replace(invisible, "")
    .replace(loneSurrogate, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!folded) return;
  const points = Array.from(folded);
  return points.length > maxDescriptionLength
    ? points.slice(0, maxDescriptionLength).join("").trimEnd()
    : folded;
}
