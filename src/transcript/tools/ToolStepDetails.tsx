/**
 * An opened tool call in Chat's steps card: no frame of its own inside the
 * card, each argument a line "key: value" (the key in muted monospace, the
 * value in the row's text), then the result as text, in the row's 12px margins.
 */
export type ToolStepOutput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "label"; label: string };

function valueText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value, null, 2);
}

export function ToolStepDetails({
  args,
  outputs,
  error,
  empty,
}: {
  args: unknown;
  outputs: ToolStepOutput[];
  error?: string;
  /** Shown when there is nothing else ("No output", "Waiting…"). */
  empty: string;
}) {
  const entries =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : [];
  const bare =
    args !== null && args !== undefined && !entries.length
      ? valueText(args)
      : undefined;
  const nothing = !entries.length && !bare && !error && !outputs.length;
  return (
    <div className="activity-body tool-step-details u-scroll-fade-y">
      {entries.map(([key, value]) => (
        <div className="tool-step-arg" key={key}>
          <code>{key}:</code> <span>{valueText(value)}</span>
        </div>
      ))}
      {bare && <div className="tool-step-arg">{bare}</div>}
      {error && <p className="tool-step-output tool-step-error">{error}</p>}
      {outputs.map((entry, index) =>
        entry.type === "image" ? (
          <img key={index} src={entry.url} alt="Tool result" />
        ) : (
          <p key={index} className="tool-step-output">
            {entry.type === "text" ? entry.text : entry.label}
          </p>
        ),
      )}
      {nothing && <p className="tool-step-output">{empty}</p>}
    </div>
  );
}
