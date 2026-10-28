import type { Item } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";
import { failed } from "../../code-tools/code-tool-model";
import { mcpOutput } from "../../transcript/tools/McpToolView";

/** One output of a step's Response: text, a picture, or a plain note. */
export type StepOutput =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "label"; label: string };

/**
 * What the ToolContent page shows for a step: its Request and its Response, or
 * that it failed with nothing returned. Everything here is shown as text only.
 */
export interface StepContent {
  request?: string;
  response: StepOutput[];
  error?: string;
  failed: boolean;
  running: boolean;
}

const json = (value: unknown) =>
  value === null || value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

const imageUrl = (value: unknown) =>
  typeof value === "string" &&
  value.length < 2_000_100 &&
  /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(value)
    ? value
    : undefined;

export function stepContent(item: Item): StepContent {
  const running = itemIsRunning(item);
  const bad =
    failed(item) || item.success === false || item.lifecycleStatus === "failed";
  const errorText =
    typeof item.error === "string"
      ? item.error
      : typeof item.error?.message === "string"
        ? item.error.message
        : undefined;
  if (item.type === "commandExecution") {
    const output =
      typeof item.aggregatedOutput === "string" && item.aggregatedOutput
        ? [{ type: "text" as const, text: item.aggregatedOutput }]
        : [];
    return {
      request: item.command,
      response: output,
      failed: bad,
      running,
    };
  }
  if (item.type === "mcpToolCall") {
    const response = mcpOutput(item).map((entry): StepOutput =>
      entry.type === "text"
        ? { type: "text", text: entry.text }
        : entry.type === "image"
          ? { type: "image", url: entry.url }
          : entry.type === "resource"
            ? {
                type: "text",
                text: [entry.uri, entry.text].filter(Boolean).join("\n"),
              }
            : { type: "label", label: entry.label },
    );
    return {
      request: json(item.arguments),
      response,
      error: errorText,
      failed: bad,
      running,
    };
  }
  if (item.type === "dynamicToolCall") {
    const outputs = Array.isArray(item.contentItems) ? item.contentItems : [];
    return {
      request: json(item.arguments),
      response: outputs.map((value: any): StepOutput => {
        if (value?.type === "inputText" && typeof value.text === "string")
          return { type: "text", text: value.text };
        const url = value?.type === "inputImage" && imageUrl(value.imageUrl);
        return url
          ? { type: "image", url }
          : { type: "label", label: "Unsupported output type" };
      }),
      error: errorText,
      failed: bad,
      running,
    };
  }
  if (item.type === "fileChange") {
    const changes = item.changes ?? [];
    return {
      request: [...new Set(changes.map((change) => change.path))].join("\n"),
      response: changes
        .filter((change) => change.diff)
        .map((change) => ({ type: "text" as const, text: change.diff })),
      failed: bad,
      running,
    };
  }
  return { response: [], error: errorText, failed: bad, running };
}

/** The ToolContent page's title: the tool's own name where it has one. */
export function toolTitle(item: Item, fallback: string) {
  if (item.type === "mcpToolCall")
    return [item.server, item.tool].filter(Boolean).join(": ") || fallback;
  if (item.type === "dynamicToolCall")
    return [item.namespace, item.tool].filter(Boolean).join(": ") || fallback;
  return fallback;
}
