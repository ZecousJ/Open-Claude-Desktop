import { randomUUID, createHash } from "node:crypto";
import {
  isToolUseLimitError,
  lengthLimitMessage,
  toolUseLimitMessage,
} from "../../shared/turn-errors";
import { readSSE } from "./gateway-support";
import type { Json } from "./gateway-support";

export function endpoint(base: string, route: string) {
  const url = new URL(base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "The base URL must be an http(s) address without a password.",
    );
  url.pathname =
    url.pathname
      .replace(
        /\/(responses|chat\/completions|models|audio\/transcriptions)\/?$/,
        "",
      )
      .replace(/\/$/, "") +
    "/" +
    route;
  return url.toString();
}

interface ToolMap {
  original: string;
  namespace?: string;
  custom: boolean;
}

/** A Responses image detail on the Chat API (which has no `original`). */
function chatDetail(detail: unknown) {
  return detail === "low" || detail === "high"
    ? detail
    : detail === "original"
      ? "high"
      : "auto";
}

/**
 * A tool output on the Chat API: the text for the tool message and the images
 * apart. A tool message carries text only; written into it, an image's
 * base64 becomes tens of thousands of text tokens the model cannot see.
 */
function chatToolOutput(output: unknown) {
  if (typeof output === "string") return { text: output, images: [] as Json[] };
  if (!Array.isArray(output))
    return { text: JSON.stringify(output), images: [] as Json[] };
  const texts: string[] = [];
  const images: Json[] = [];
  for (const part of output) {
    if (["input_text", "output_text", "text"].includes(part?.type))
      texts.push(part.text ?? "");
    else if (part?.type === "input_image" && typeof part.image_url === "string")
      images.push({
        type: "image_url",
        image_url: { url: part.image_url, detail: chatDetail(part.detail) },
      });
    else texts.push(JSON.stringify(part));
  }
  const text = texts.join("\n").trim();
  return {
    text:
      text ||
      (images.length > 1
        ? "The images are attached below."
        : images.length
          ? "The image is attached below."
          : ""),
    images,
  };
}

export function toChat(request: Json) {
  if (request.previous_response_id)
    throw new Error(
      "Chat compatibility mode needs the full conversation history and cannot use previous_response_id.",
    );
  const mapping = new Map<string, ToolMap>();
  const tools: Json[] = [];
  const toolNames = new Map<string, string>();
  const keyFor = (name: string, namespace?: string) =>
    JSON.stringify([namespace ?? null, name]);
  const chatName = (name: string, namespace?: string) => {
    const full = namespace ? `${namespace}__${name}` : name;
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(full)) return full;
    return `tool_${createHash("sha256").update(keyFor(name, namespace)).digest("hex").slice(0, 48)}`;
  };
  const add = (tool: Json, namespace?: string) => {
    if (tool.type === "namespace") {
      if (namespace)
        throw new Error(
          "The Chat API does not support nested tool namespaces.",
        );
      for (const t of tool.tools ?? []) add(t, tool.name);
      return;
    }
    if (!["function", "custom"].includes(tool.type))
      throw new Error(
        `The Chat API does not support the built-in tool ${tool.type}. Turn the tool off or use the Responses API.`,
      );
    if (typeof tool.name !== "string" || !tool.name)
      throw new Error("A tool is missing its name.");
    let name = chatName(tool.name, namespace);
    const key = keyFor(tool.name, namespace);
    if (toolNames.has(key))
      throw new Error(`Duplicate tool name: ${tool.name}`);
    if (mapping.has(name))
      name = `tool_${createHash("sha256").update(key).digest("hex").slice(0, 48)}`;
    toolNames.set(key, name);
    mapping.set(name, {
      original: tool.name,
      namespace,
      custom: tool.type === "custom",
    });
    let description = tool.description ?? "";
    if (tool.type === "custom" && tool.format?.type === "grammar")
      description += `\nRaw input must follow this ${tool.format.syntax ?? ""} grammar:\n${tool.format.definition ?? ""}`;
    tools.push({
      type: "function",
      function: {
        name,
        description,
        parameters:
          tool.type === "custom"
            ? {
                type: "object",
                properties: {
                  input: {
                    type: "string",
                    description:
                      "The complete raw tool input, following the tool instructions.",
                  },
                },
                required: ["input"],
                additionalProperties: false,
              }
            : (tool.parameters ?? { type: "object", properties: {} }),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    });
  };
  for (const tool of request.tools ?? []) add(tool);
  const messages: Json[] = [];
  if (request.instructions)
    messages.push({ role: "system", content: request.instructions });
  const input =
    typeof request.input === "string"
      ? [{ role: "user", content: request.input }]
      : (request.input ?? []);
  // Images from tool outputs follow the tool messages in one user message
  // (the tool messages of one assistant turn must stay together).
  let toolImages: Json[] = [];
  const flushToolImages = () => {
    if (toolImages.length) messages.push({ role: "user", content: toolImages });
    toolImages = [];
  };
  for (const item of input) {
    if (item.type === "reasoning") continue;
    const toolOutput = [
      "function_call_output",
      "custom_tool_call_output",
    ].includes(item.type);
    if (!toolOutput) flushToolImages();
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      const name =
        toolNames.get(keyFor(item.name, item.namespace)) ??
        chatName(item.name, item.namespace);
      const call = {
        id: item.call_id,
        type: "function",
        function: {
          name,
          arguments:
            item.type === "custom_tool_call"
              ? JSON.stringify({ input: item.input })
              : item.arguments,
        },
      };
      const last = messages.at(-1);
      if (last?.role === "assistant" && last.tool_calls)
        last.tool_calls.push(call);
      else
        messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (toolOutput) {
      const { text, images } = chatToolOutput(item.output);
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: text,
      });
      if (images.length)
        toolImages.push(
          {
            type: "text",
            text: `[Image output of tool call ${item.call_id}]`,
          },
          ...images,
        );
    } else if (item.role) {
      let content: any = item.content;
      if (Array.isArray(content))
        content = content.map((part: Json) => {
          if (["input_text", "output_text", "text"].includes(part.type))
            return { type: "text", text: part.text };
          if (part.type === "input_image")
            return {
              type: "image_url",
              image_url: {
                url: part.image_url,
                detail: chatDetail(part.detail),
              },
            };
          if (part.type === "refusal")
            return { type: "refusal", refusal: part.refusal };
          throw new Error(
            `The Chat API does not support attachments of type ${part.type}.`,
          );
        });
      messages.push({
        role: item.role === "developer" ? "system" : item.role,
        content,
      });
    } else
      throw new Error(
        `The Chat API does not support conversation items of type ${item.type ?? "unknown"}.`,
      );
  }
  flushToolImages();
  const body: Json = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length) body.tools = tools;
  if (request.tool_choice !== undefined) {
    if (
      typeof request.tool_choice === "string" &&
      ["auto", "none", "required"].includes(request.tool_choice)
    )
      body.tool_choice = request.tool_choice;
    else if (["function", "custom"].includes(request.tool_choice?.type)) {
      const name = toolNames.get(
        keyFor(request.tool_choice.name, request.tool_choice.namespace),
      );
      if (!name) throw new Error("tool_choice names an unknown tool.");
      body.tool_choice = { type: "function", function: { name } };
    } else
      throw new Error(
        "The Chat API does not support this tool_choice. Use auto, none, required or a named tool.",
      );
  } else if (tools.length) body.tool_choice = "auto";
  if (request.parallel_tool_calls !== undefined)
    body.parallel_tool_calls = request.parallel_tool_calls;
  if (request.reasoning?.effort)
    body.reasoning_effort = request.reasoning.effort;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.max_output_tokens)
    body.max_completion_tokens = request.max_output_tokens;
  if (request.text?.format && request.text.format.type !== "text") {
    const { type, ...format } = request.text.format;
    if (type === "json_schema")
      body.response_format = { type, json_schema: format };
    else if (type === "json_object") body.response_format = { type };
    else
      throw new Error(
        `The Chat API does not support the output format ${type}.`,
      );
  }
  return { body, mapping };
}

export async function streamChatResponse(
  upstream: Response,
  send: (event: Json) => void,
  mapping: Map<string, ToolMap>,
  model: string,
  onUsage?: (usage: Json) => void,
  /** A tool call opens (observers only: it never reaches Codex early). */
  onOpen?: (event: Json) => void,
) {
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let sequence = 0;
  let text = "";
  let textStarted = false;
  let finished = false;
  let usage: Json = {};
  const calls = new Map<number, Json>();
  const output: Json[] = [];
  const emit = (event: Json) => send({ ...event, sequence_number: sequence++ });
  const response = (status: string) => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    model,
    status,
    output: [...output],
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens:
        usage.total_tokens ??
        (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
      input_tokens_details: {
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
      output_tokens_details: {
        reasoning_tokens:
          usage.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    },
  });
  emit({ type: "response.created", response: response("in_progress") });
  emit({ type: "response.in_progress", response: response("in_progress") });
  if (!upstream.body)
    throw new Error("The model did not return a streaming response.");
  for await (const chunk of readSSE(upstream.body)) {
    if (chunk.error)
      throw new Error(chunk.error.message ?? "The model returned an error.");
    if (chunk.usage) {
      usage = chunk.usage;
      onUsage?.(usage);
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (delta.function_call)
      throw new Error(
        "The model returned a legacy function_call. Use a Chat-compatible API that supports tool_calls.",
      );
    if (delta.refusal)
      throw new Error(`The model refused this request: ${delta.refusal}`);
    if (typeof delta.content === "string" && delta.content) {
      if (!textStarted) {
        textStarted = true;
        emit({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        });
        emit({
          type: "response.content_part.added",
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }
      text += delta.content;
      emit({
        type: "response.output_text.delta",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: delta.content,
      });
    }
    for (const call of delta.tool_calls ?? []) {
      if (!Number.isInteger(call.index) || call.index < 0)
        throw new Error("A model tool call is missing a valid index.");
      const current = calls.get(call.index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      if (call.id) current.id = call.id;
      current.name += call.function?.name ?? "";
      current.arguments += call.function?.arguments ?? "";
      calls.set(call.index, current);
      // The call opens: observers hear of it now, Codex once it is whole.
      if (!current.announced && current.id && current.name) {
        current.announced = true;
        const mapped = mapping.get(current.name);
        onOpen?.({
          type: "response.output_item.added",
          item: {
            type: mapped?.custom ? "custom_tool_call" : "function_call",
            call_id: current.id,
            name: mapped?.original ?? current.name,
            ...(mapped?.namespace ? { namespace: mapped.namespace } : {}),
          },
        });
      }
    }
    if (choice.finish_reason === "length") throw new Error(lengthLimitMessage);
    if (isToolUseLimitError(choice.finish_reason))
      throw new Error(toolUseLimitMessage);
    if (choice.finish_reason === "content_filter")
      throw new Error("The model provider blocked this response.");
    if (choice.finish_reason) finished = true;
  }
  if (!finished)
    throw new Error(
      "The model connection closed before the response finished.",
    );
  if (textStarted) {
    const part = { type: "output_text", text, annotations: [] };
    emit({
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    });
    emit({
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part,
    });
    const item = {
      id: messageId,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [part],
    };
    output.push(item);
    emit({ type: "response.output_item.done", output_index: 0, item });
  }
  for (const call of [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)) {
    // A tool the request does not offer (a model inventing one from a skill's
    // text) goes to Codex as a plain function call: Codex answers it
    // "unsupported" and the model carries on.
    const mapped: ToolMap = mapping.get(call.name) ?? {
      original: call.name,
      custom: false,
    };
    const id = `fc_${randomUUID()}`;
    const index = output.length;
    const common = {
      id,
      call_id: call.id || `call_${randomUUID()}`,
      name: mapped.original,
      ...(mapped.namespace ? { namespace: mapped.namespace } : {}),
    };
    let item: Json;
    if (mapped.custom) {
      const parsed = JSON.parse(call.arguments);
      if (!parsed || typeof parsed.input !== "string")
        throw new Error("The tool arguments are missing the input string.");
      item = {
        ...common,
        type: "custom_tool_call",
        input: parsed.input,
        status: "completed",
      };
      emit({
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, input: "", status: "in_progress" },
      });
      emit({
        type: "response.custom_tool_call_input.delta",
        output_index: index,
        item_id: id,
        delta: item.input,
      });
      emit({
        type: "response.custom_tool_call_input.done",
        output_index: index,
        item_id: id,
        input: item.input,
      });
    } else {
      const parsed = JSON.parse(call.arguments || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw new Error("Function tool arguments must be a JSON object.");
      item = {
        ...common,
        type: "function_call",
        arguments: call.arguments || "{}",
        status: "completed",
      };
      emit({
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, arguments: "", status: "in_progress" },
      });
      emit({
        type: "response.function_call_arguments.delta",
        output_index: index,
        item_id: id,
        delta: item.arguments,
      });
      emit({
        type: "response.function_call_arguments.done",
        output_index: index,
        item_id: id,
        arguments: item.arguments,
      });
    }
    output.push(item);
    emit({ type: "response.output_item.done", output_index: index, item });
  }
  emit({ type: "response.completed", response: response("completed") });
}
