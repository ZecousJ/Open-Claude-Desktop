import { ChevronRight } from "../../ui/glyphs";
import type { Item } from "../../../shared/types";
import { mcpOutput } from "../tools/McpToolView";
import { McpResourceLinks } from "../tools/McpResourceLinks";

function label(item: Item) {
  if (item.type === "mcpToolCall")
    return `Used ${item.server ?? "a tool"}: ${item.tool ?? "Tool"}`;
  if (item.type === "dynamicToolCall") return `Used ${item.tool ?? "a tool"}`;
  return "Used a tool";
}
function inputText(value: unknown) {
  if (value === undefined || value === null) return;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text;
  } catch {
    return;
  }
}
export function AgentPriorTool({ item }: { item: Item }) {
  const output = item.type === "mcpToolCall" ? mcpOutput(item) : [];
  const dynamic =
    item.type === "dynamicToolCall" && Array.isArray(item.contentItems)
      ? item.contentItems.filter((part) => part.type !== "resource_link")
      : [];
  const input = inputText(item.arguments);
  const error =
    typeof item.error === "string"
      ? item.error
      : typeof item.error?.message === "string"
        ? item.error.message
        : undefined;
  return (
    <details className="single-agent-prior-tool">
      <summary>
        {label(item)}
        <ChevronRight size={15} />
      </summary>
      <div className="single-agent-prior-body">
        {input && (
          <section>
            <strong>Input</strong>
            <pre>{input}</pre>
          </section>
        )}
        {output.length > 0 && (
          <section>
            <strong>Output</strong>
            {output.map((part, index) =>
              part.type === "text" ? (
                <pre key={index}>{part.text}</pre>
              ) : part.type === "resource" ? (
                <pre key={index}>{part.text ?? part.uri}</pre>
              ) : part.type === "image" ? (
                <img key={index} src={part.url} alt="Tool result" />
              ) : (
                <p key={index}>{part.label}</p>
              ),
            )}
          </section>
        )}
        {dynamic.length > 0 && (
          <section>
            <strong>Output</strong>
            {dynamic.map((part: any, index: number) =>
              typeof part?.text === "string" ? (
                <pre key={index}>{part.text.slice(0, 20_000)}</pre>
              ) : (
                <p key={index}>
                  {part?.type === "inputImage" ? "Image result" : "Tool result"}
                </p>
              ),
            )}
          </section>
        )}
        {error && (
          <section>
            <strong>Error</strong>
            <pre>{error.slice(0, 20_000)}</pre>
          </section>
        )}
        <McpResourceLinks item={item} placeholder />
        {!input && !output.length && !dynamic.length && !error && (
          <p>No additional details</p>
        )}
      </div>
    </details>
  );
}
