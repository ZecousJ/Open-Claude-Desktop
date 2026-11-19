/**
 * Computer use (R10) for the preview. Without `cu` nothing of it shows (as
 * when the policy or the computer doesn't allow it). With it:
 *   cu=off           Settings → System shows the section, switched off
 *   cu=on            switched on, both macOS permissions granted
 *   cu=denied        on, with denied apps (one set by the administrator)
 *   cu=perm-missing  on, Accessibility not granted, Screen recording needs a restart
 *   cu=nofull        on, the administrator doesn't allow full control
 *   cu=request       on, plus the "Computer use test" Cowork chat: finished
 *                    tool rows with screenshots and a running access request
 *   cu=fullcontrol   the same chat asking to take full control
 *   cu=background    the same chat while Claudex works in TextEdit in the background
 *   cu=done          the same chat after the task finished (rows with screenshots)
 * Screenshots are drawn locally (canvas JPEG); nothing reaches a network.
 */
import type {
  ComputerUseAccessRequest,
  ComputerUseAppRef,
  ComputerUseState,
} from "../../../shared/computer-use-api";
import { unavailableComputerUse } from "../../../shared/computer-use-api";
import type { Conversation, Item } from "../../../shared/types";
import type { FixtureDomain } from "./index";

const shotIds = [
  "5f1c1a52-4a0b-4f7e-9d1e-0b9d7d3c2a11",
  "8a2e7c10-3b4d-4c5e-8f60-1a2b3c4d5e6f",
];

const appIcon = (color: string, letter: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect x="2" y="2" width="36" height="36" rx="9" fill="${color}"/><text x="20" y="27" font-family="Helvetica" font-size="19" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`,
  )}`;

const installed: (ComputerUseAppRef & { icon?: string })[] = [
  { id: "com.apple.TextEdit", name: "TextEdit", color: "#5b8def", l: "T" },
  { id: "com.apple.finder", name: "Finder", color: "#3a9bdc", l: "F" },
  { id: "com.apple.Notes", name: "Notes", color: "#e8b923", l: "N" },
  { id: "com.apple.Safari", name: "Safari", color: "#2f7de1", l: "S" },
  { id: "com.apple.Terminal", name: "Terminal", color: "#2b2b2b", l: ">" },
  { id: "com.apple.MobileSMS", name: "Messages", color: "#34c759", l: "M" },
  { id: "com.tinyspeck.slackmacgap", name: "Slack", color: "#611f69", l: "S" },
  { id: "com.apple.iWork.Numbers", name: "Numbers", color: "#1fa855", l: "N" },
].map(({ color, l, ...app }) => ({
  ...app,
  platform: "darwin" as const,
  icon: appIcon(color, l),
}));
const ref = (id: string) => {
  const { icon: _icon, ...app } = installed.find((a) => a.id === id)!;
  return app;
};

/** A synthetic TextEdit window, as the broker's JPEG screenshots look. */
function screenshot(size: "thumb" | "full") {
  const width = size === "thumb" ? 480 : 1200;
  const height = Math.round(width * 0.625);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  const s = width / 1200;
  g.fillStyle = "#ececec";
  g.fillRect(0, 0, width, height);
  g.fillStyle = "#d8d8d8";
  g.fillRect(0, 0, width, 56 * s);
  ["#ff5f57", "#febc2e", "#28c840"].forEach((color, i) => {
    g.fillStyle = color;
    g.beginPath();
    g.arc((28 + i * 26) * s, 28 * s, 8 * s, 0, Math.PI * 2);
    g.fill();
  });
  g.fillStyle = "#333";
  g.font = `${22 * s}px Helvetica`;
  g.fillText("Shopping list.txt", 520 * s, 36 * s);
  g.fillStyle = "#fff";
  g.fillRect(40 * s, 90 * s, 1120 * s, 620 * s);
  g.fillStyle = "#222";
  g.font = `${26 * s}px Helvetica`;
  ["Shopping list", "", "- Oat milk", "- Apples", "- Coffee beans"].forEach(
    (line, i) => g.fillText(line, 80 * s, (150 + i * 44) * s),
  );
  return canvas.toDataURL("image/jpeg", 0.8);
}

const mcp = (
  id: string,
  tool: string,
  args: Record<string, unknown>,
  result?: Item["result"],
  status: Item["status"] = "completed",
): Item => ({
  id,
  type: "mcpToolCall",
  server: "computer-use",
  tool,
  status,
  arguments: args,
  ...(result ? { result } : {}),
});
const text = (value: string) => ({ type: "text", text: value });

function testConversation(now: number, variant: string): Conversation {
  const running =
    variant === "request" ||
    variant === "fullcontrol" ||
    variant === "background";
  const items: Item[] = [
    mcp("cu-list", "list_apps", {}, {
      content: [text("TextEdit — com.apple.TextEdit\nFinder — com.apple.finder")],
    }),
    mcp(
      "cu-access",
      "request_access",
      { apps: ["TextEdit"], reason: "To add items to your shopping list." },
      { content: [text("TextEdit: granted (full access).")] },
    ),
    mcp(
      "cu-shot",
      "screenshot",
      { app: "com.apple.TextEdit" },
      {
        content: [
          text("TextEdit · screenshot · full access"),
          text(`claudex-screenshot://${shotIds[0]}`),
        ],
      },
    ),
    mcp(
      "cu-type",
      "type_text",
      { app: "com.apple.TextEdit", text: "- Coffee beans" },
      { content: [text("TextEdit · type_text · full access\nTyped.")] },
    ),
    mcp(
      "cu-key",
      "press_key",
      { app: "com.apple.TextEdit", key: "super+s" },
      { content: [text("TextEdit · press_key · full access\nPressed.")] },
    ),
    mcp(
      "cu-safari",
      "click",
      { app: "com.apple.Safari", element_index: "4" },
      {
        content: [
          text("Safari is granted view-only: clicks and typing are blocked."),
        ],
        isError: true,
      },
    ),
    mcp(
      "cu-state",
      "get_app_state",
      { app: "com.apple.TextEdit" },
      {
        content: [
          text("TextEdit · get_app_state · full access\n0 AXWindow Shopping list.txt"),
          text(`claudex-screenshot://${shotIds[1]}`),
        ],
      },
    ),
  ];
  if (variant === "request")
    items.push(
      mcp(
        "cu-access-2",
        "request_access",
        {
          apps: ["Notes", "Finder", "Safari"],
          reason: "To copy the list into Notes and check the store's hours.",
        },
        undefined,
        "inProgress",
      ),
    );
  if (variant === "fullcontrol")
    items.push(
      mcp(
        "cu-full",
        "request_full_control",
        { reason: "TextEdit's print dialog only responds to the real mouse." },
        undefined,
        "inProgress",
      ),
    );
  if (variant === "background")
    items.push(
      mcp(
        "cu-click",
        "click",
        { app: "com.apple.TextEdit", element_index: "12" },
        undefined,
        "inProgress",
      ),
    );
  return {
    id: "c-computer-use",
    threadId: "thread-c-computer-use",
    title: "Computer use test",
    providerId: "fixture",
    model: "Opus 5.5",
    mode: "cowork",
    pinned: false,
    archived: false,
    createdAt: now - 5 * 60_000,
    updatedAt: now - 60_000,
    turns: [
      {
        id: "cu-t1",
        prompt: "Add coffee beans to my shopping list in TextEdit and save it.",
        attachments: [],
        status: running ? "inProgress" : "completed",
        createdAt: now - 5 * 60_000,
        items: running
          ? items
          : [
              ...items,
              {
                id: "cu-reply",
                type: "agentMessage",
                text: "I added coffee beans to the list and saved it.",
              },
            ],
      },
    ],
  };
}

function requestFor(variant: string): ComputerUseAccessRequest | undefined {
  if (variant === "request")
    return {
      id: "0d6c7a3e-1f2b-4c3d-9e4f-5a6b7c8d9e0f",
      conversationId: "c-computer-use",
      kind: "apps",
      reason: "To copy the list into Notes and check the store's hours.",
      apps: [
        {
          app: ref("com.apple.Notes"),
          tier: "full",
          icon: installed[2].icon,
        },
        {
          app: ref("com.apple.finder"),
          tier: "full",
          icon: installed[1].icon,
        },
        {
          app: ref("com.apple.Safari"),
          tier: "read",
          icon: installed[3].icon,
        },
      ],
      deniedAutomatically: [
        { id: "com.1password.1password", name: "1Password", platform: "darwin" },
      ],
    };
  if (variant === "fullcontrol")
    return {
      id: "7b1e2d3c-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      conversationId: "c-computer-use",
      kind: "full-control",
      reason: "TextEdit's print dialog only responds to the real mouse.",
      apps: [{ app: ref("com.apple.TextEdit"), tier: "full" }],
    };
  return undefined;
}

export const computerUseFixture: FixtureDomain = {
  params: {
    cu: "off|on|denied|perm-missing|nofull|request|fullcontrol|background|done",
  },
  bridge: ({ params, state, origin, emit }) => {
    const variant = params.get("cu");
    const unavailable = async (): Promise<never> => {
      throw new Error("Computer use isn't available right now.");
    };
    if (!variant)
      return {
        computerUseState: async () => structuredClone(unavailableComputerUse),
        computerUseInstalledApps: async () => [],
        computerUseScreenshot: async () => null,
        saveComputerUseSettings: unavailable,
        requestComputerUsePermission: unavailable,
        openComputerUsePermissionSettings: unavailable,
        relaunchForPermissions: unavailable,
        answerComputerUseAccess: unavailable,
        stopComputerUse: async () => {},
      };
    if (["request", "fullcontrol", "background", "done"].includes(variant))
      state.conversations.unshift(testConversation(origin, variant));
    const request = requestFor(variant);
    const cu: ComputerUseState = {
      available: true,
      settings: {
        enabled: variant !== "off",
        mode: "background",
        unhideApps: true,
        deniedApps:
          variant === "denied"
            ? [ref("com.apple.MobileSMS"), ref("com.tinyspeck.slackmacgap")]
            : [],
      },
      allowFullControl: variant !== "nofull",
      adminDeniedApps: variant === "denied" ? ["com.apple.Terminal"] : [],
      canHideApps: true,
      permissions: {
        platform: "darwin",
        accessibility:
          variant === "perm-missing" ? "not-determined" : "granted",
        screen: variant === "perm-missing" ? "restart-required" : "granted",
      },
      activity:
        variant === "background"
          ? {
              conversationId: "c-computer-use",
              mode: "background",
              app: ref("com.apple.TextEdit"),
              action: "Clicking in",
              startedAt: origin,
            }
          : null,
      requests: request ? [request] : [],
    };
    const snapshot = () => structuredClone(cu);
    return {
      computerUseState: async () => snapshot(),
      computerUseInstalledApps: async () => structuredClone(installed),
      computerUseScreenshot: async (id, size) =>
        shotIds.includes(id) ? screenshot(size) : null,
      saveComputerUseSettings: async (patch) => {
        cu.settings = { ...cu.settings, ...structuredClone(patch) };
        return snapshot();
      },
      requestComputerUsePermission: async (kind) => {
        if (kind === "accessibility")
          cu.permissions!.accessibility = "granted";
        else cu.permissions!.screen = "restart-required";
        emit({ type: "computer-use", permissions: cu.permissions });
        return structuredClone(cu.permissions!);
      },
      openComputerUsePermissionSettings: async () => {},
      relaunchForPermissions: async () => {
        cu.permissions!.screen = "granted";
        emit({ type: "computer-use", permissions: cu.permissions });
      },
      answerComputerUseAccess: async (id, decision) => {
        (
          globalThis as { fixtureComputerUseAnswers?: unknown[] }
        ).fixtureComputerUseAnswers ??= [];
        (
          globalThis as { fixtureComputerUseAnswers?: unknown[] }
        ).fixtureComputerUseAnswers!.push({ id, decision });
        cu.requests = (cu.requests ?? []).filter((r) => r.id !== id);
        emit({ type: "computer-use", resolved: id });
      },
      stopComputerUse: async () => {
        cu.activity = null;
        cu.requests = [];
        emit({ type: "computer-use", activity: null });
      },
    };
  },
};
