import { type McpTool } from "./mcp-server";

// ---------------------------------------------------------------------------
// Tool definitions

const tabIdSchema = {
  type: "string",
  description:
    "A tab id from tabs_list (tab-N). Leave it out to use the tab the Browser panel shows.",
};

const refSchema = {
  type: "string",
  description: "An element ref (ref_N) from read_page or find.",
};

const coordinateSchema = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
  description:
    "[x, y] in CSS pixels of the page viewport (screenshot pixels divided by its scale).",
};

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  readOnly = false,
): McpTool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: { readOnlyHint: readOnly, openWorldHint: true },
  };
}

export const pageTools: McpTool[] = [
  tool(
    "tabs_list",
    "List the tabs of the built-in browser in this Code session's Browser panel: id, title, URL, loading state and which one is shown.",
    {},
    [],
    true,
  ),
  tool(
    "tab_new",
    "Open a new tab in the built-in browser (Browser panel), optionally opening a URL in it. The new tab is shown.",
    { url: { type: "string", description: "The page to open (optional)." } },
  ),
  tool(
    "tab_select",
    "Show a tab of the built-in browser in the Browser panel.",
    { tabId: tabIdSchema },
    ["tabId"],
  ),
  tool(
    "tab_close",
    "Close a tab of the built-in browser.",
    { tabId: tabIdSchema },
    ["tabId"],
  ),
  tool(
    "navigate",
    'Open a web page (URL) in the built-in browser of the Browser panel and wait for it to load, or go "back", "forward" or "reload". Use it to preview the app from a dev server (http://localhost:PORT) or to visit a website.',
    {
      url: {
        type: "string",
        description:
          'The address (https://example.com, localhost:5173) or "back", "forward", "reload".',
      },
      tabId: tabIdSchema,
    },
    ["url"],
  ),
  tool(
    "screenshot",
    "Take a screenshot of the web page in the built-in browser (the visible part, the full page, or one element) to check how it looks.",
    {
      tabId: tabIdSchema,
      fullPage: { type: "boolean", description: "The whole page." },
      ref: refSchema,
    },
    [],
    true,
  ),
  tool(
    "read_page",
    "Read the web page in the built-in browser as an accessibility tree. Each element has a ref (ref_N) for click, type, form_input and screenshot.",
    {
      tabId: tabIdSchema,
      ref: { ...refSchema, description: "Read only under this element." },
      filter: {
        type: "string",
        enum: ["all", "interactive"],
        description: '"interactive" lists only elements you can act on.',
      },
      maxChars: { type: "integer", minimum: 1000, maximum: 200000 },
    },
    [],
    true,
  ),
  tool(
    "find",
    "Find elements on the web page in the built-in browser whose role, name or text contains the query; returns their refs.",
    { query: { type: "string" }, tabId: tabIdSchema },
    ["query"],
    true,
  ),
  tool(
    "get_text",
    "Get the readable text of the web page in the built-in browser (the main content when the page marks one).",
    {
      tabId: tabIdSchema,
      maxChars: { type: "integer", minimum: 1000, maximum: 200000 },
    },
    [],
    true,
  ),
  tool(
    "click",
    "Click an element (by ref) or a point on the web page in the built-in browser.",
    {
      ref: refSchema,
      coordinate: coordinateSchema,
      button: { type: "string", enum: ["left", "right", "middle"] },
      clickCount: { type: "integer", minimum: 1, maximum: 3 },
      modifiers: {
        type: "string",
        description: 'Keys held down, like "shift" or "cmd+shift".',
      },
      tabId: tabIdSchema,
    },
  ),
  tool(
    "hover",
    "Move the pointer over an element (by ref) or a point on the web page in the built-in browser.",
    { ref: refSchema, coordinate: coordinateSchema, tabId: tabIdSchema },
  ),
  tool(
    "type",
    "Type text into the focused field of the web page in the built-in browser, or into an element after clicking it (ref).",
    {
      text: { type: "string" },
      ref: {
        ...refSchema,
        description: "Click this element first to focus it (optional).",
      },
      tabId: tabIdSchema,
    },
    ["text"],
  ),
  tool(
    "key",
    'Press keys on the web page in the built-in browser: space-separated chords like "Enter", "Tab", "cmd+a Backspace".',
    {
      keys: { type: "string" },
      repeat: { type: "integer", minimum: 1, maximum: 100 },
      tabId: tabIdSchema,
    },
    ["keys"],
  ),
  tool(
    "scroll",
    "Scroll the web page in the built-in browser (at an element or point, the middle by default).",
    {
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Wheel ticks of 100 pixels (3 by default).",
      },
      ref: refSchema,
      coordinate: coordinateSchema,
      tabId: tabIdSchema,
    },
    ["direction"],
  ),
  tool(
    "form_input",
    "Set the value of a form field on the web page in the built-in browser: text, a list choice, or a checkbox (true/false).",
    {
      ref: refSchema,
      value: { type: ["string", "boolean", "number"] },
      tabId: tabIdSchema,
    },
    ["ref", "value"],
  ),
  tool(
    "handle_dialog",
    "Answer the confirm, prompt or leave-page dialog the web page in the built-in browser is showing.",
    {
      accept: { type: "boolean" },
      text: { type: "string", description: "A prompt's answer." },
      tabId: tabIdSchema,
    },
    ["accept"],
  ),
  tool(
    "console",
    "Read the browser console messages of the web page in the built-in browser (errors, warnings, logs) to debug the app.",
    {
      pattern: {
        type: "string",
        description: "Only messages containing this.",
      },
      onlyErrors: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      tabId: tabIdSchema,
    },
    [],
    true,
  ),
  tool(
    "network",
    "List the network requests of the web page in the built-in browser (URL, method, status, failures) to debug the app.",
    {
      urlPattern: { type: "string" },
      onlyFailed: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      tabId: tabIdSchema,
    },
    [],
    true,
  ),
  tool(
    "resize",
    'Show pages as a phone ("mobile"), tablet ("tablet"), at the panel\'s width ("desktop"), or custom {width, height} CSS pixels.',
    {
      viewport: {
        anyOf: [
          { type: "string", enum: ["desktop", "mobile", "tablet"] },
          {
            type: "object",
            properties: {
              width: { type: "integer", minimum: 1, maximum: 10000 },
              height: { type: "integer", minimum: 1, maximum: 10000 },
            },
            required: ["width", "height"],
            additionalProperties: false,
          },
        ],
      },
    },
    ["viewport"],
  ),
];

export const scriptTool = tool(
  "evaluate",
  "Run a JavaScript expression in the web page in the built-in browser and return its value as JSON (at most 20 KB).",
  { expression: { type: "string" }, tabId: tabIdSchema },
  ["expression"],
);

export const devServerTools: McpTool[] = [
  tool(
    "preview_list",
    "List the dev servers of this project (.claude/launch.json) and whether they are running, with their URLs.",
    {},
    [],
    true,
  ),
  tool(
    "preview_start",
    "Start a dev server from .claude/launch.json by name, wait until it answers, and open its URL in the Browser panel to preview the app.",
    { name: { type: "string" } },
    ["name"],
  ),
  tool(
    "preview_stop",
    "Stop a running dev server by name.",
    { name: { type: "string" } },
    ["name"],
  ),
  tool(
    "preview_logs",
    "Read a dev server's output (build errors, requests).",
    {
      name: { type: "string" },
      lines: { type: "integer", minimum: 1, maximum: 2000 },
      search: { type: "string", description: "Only lines containing this." },
      level: { type: "string", enum: ["all", "error"] },
    },
    ["name"],
    true,
  ),
];
