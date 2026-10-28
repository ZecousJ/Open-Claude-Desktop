import type {
  ComputerUseContent,
  ComputerUseTier,
  ComputerUseToolResult,
} from "../../shared/computer-use";
import { screenshotRef } from "../../shared/computer-use";
import { appKey, tierLabels } from "./app-tiers";
import {
  maxTypedText,
  normalizeKey,
  keyBlocked,
  text,
  Refusal,
  actionTier,
  tierRank,
  actionLabels,
  str,
  num,
  optionalIndex,
} from "./broker-support";
import type { ComputerUseBroker } from "./broker";
import type { BrokerConversation, KnownApp } from "./broker";

// Live preview is subscribed only while the activity card is expanded.
export async function preview(
  this: ComputerUseBroker,
  conversationId: string,
): Promise<string | null> {
  const activity = this.activity;
  const turn = this.deps.conversation(conversationId)?.turnId;
  const allowed = () => {
    const conversation = this.deps.conversation(conversationId);
    const grant =
      activity?.app &&
      this.grants.get(conversationId)?.get(appKey(activity.app.id));
    return (
      activity?.conversationId === conversationId &&
      this.activity === activity &&
      conversation?.running &&
      conversation.turnId === turn &&
      !this.refusalFor(conversation) &&
      !this.turns.get(conversationId)?.halted &&
      grant &&
      !this.deniedBy(grant.app) &&
      this.mode(conversationId) === activity.mode &&
      (activity.mode !== "fullControl" ||
        this.deps.policy().allowFullControl) &&
      (!this.control || this.control.conversationId === conversationId)
    );
  };
  if (!allowed() || !activity?.app) return null;
  const target = await this.target(conversationId, activity.app);
  return this.exclusive(async () => {
    if (!allowed()) return null;
    const result = await this.deps.driver.call(
      "get_app_state",
      { app: target, max_tree_nodes: 1, max_tree_depth: 1 },
      activity.mode,
    );
    if (!allowed()) return null;
    const image = result.content.find((item) => item.type === "image");
    if (
      !image ||
      image.type !== "image" ||
      !/^image\/(?:png|jpeg|webp)$/.test(image.mimeType) ||
      image.data.length > 4_000_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    )
      return null;
    return `data:${image.mimeType};base64,${image.data}`;
  });
}

export async function clipboard(
  this: ComputerUseBroker,
  conversationId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ComputerUseToolResult> {
  const allowed = this.clipboardGrants.get(conversationId);
  const full = this.control?.conversationId === conversationId;
  if (!full && !(tool === "read_clipboard" ? allowed?.read : allowed?.write))
    throw new Refusal(
      "The clipboard needs full control, or request_access with clipboard_read or clipboard_write.",
    );
  if (tool === "read_clipboard")
    return { content: [text(await this.deps.clipboard.read())] };
  if (typeof args.text !== "string" || args.text.length > 20_000)
    throw new Refusal("text must be at most 20000 characters.");
  await this.deps.clipboard.write(args.text);
  return { content: [text("Copied to the clipboard.")] };
}

// -------------------------------------------------------------------------
// Actions on an app.

/** The exact target the driver takes: a bundle id, or a Windows process id. */
export async function target(
  this: ComputerUseBroker,
  conversationId: string,
  app: KnownApp,
) {
  if (this.deps.platform !== "win32") return app.id;
  const running = (await this.driverApps(conversationId, true)).filter(
    (candidate) =>
      appKey(candidate.id) === appKey(app.id) && candidate.pid !== undefined,
  );
  if (!running.length)
    throw new Refusal(
      `${app.name} isn't running. Call open_application first.`,
    );
  return String((running.find((item) => item.frontmost) ?? running[0]).pid);
}

export function scale(
  this: ComputerUseBroker,
  conversationId: string,
  app: KnownApp,
) {
  return this.scales.get(conversationId)?.get(appKey(app.id)) ?? 1;
}

export async function act(
  this: ComputerUseBroker,
  conversationId: string,
  conversation: BrokerConversation,
  tool: string,
  args: Record<string, unknown>,
): Promise<ComputerUseToolResult> {
  if (this.teachingPending.has(conversationId))
    throw new Refusal("Wait for the person to choose Next or Exit.");
  const grant = await this.granted(conversationId, args.app);
  const { app, tier } = grant;
  const needed = actionTier[tool]!;
  // Click-only apps get left clicks and scrolling; right clicks count as full.
  const button = args.mouse_button ?? "left";
  const needs: ComputerUseTier =
    tool === "click" && button !== "left" ? "full" : needed;
  if (tierRank[tier] < tierRank[needs])
    throw new Refusal(
      tier === "read"
        ? `${app.name} is granted view-only: clicks and typing are blocked.`
        : `${app.name} is granted click-only: typing, key presses, right clicks and dragging are blocked.`,
    );
  const mode = this.mode(conversationId);
  if (mode === "background")
    this.setActivity({
      conversationId,
      mode: "background",
      app: this.refOf(app),
      action: actionLabels[tool],
      startedAt: this.activity?.startedAt ?? this.now(),
    });
  else {
    this.control = { conversationId, app };
    this.deps.fullControl.update(app.name);
    this.setActivity({
      conversationId,
      mode: "fullControl",
      app: this.refOf(app),
      action: actionLabels[tool],
      startedAt: this.activity?.startedAt ?? this.now(),
    });
  }
  const header = `${app.name} · ${tool} · ${tierLabels[tier]}`;

  if (tool === "open_application") {
    await this.exclusive(() => this.deps.openApp(app, mode === "background"));
    this.appCache = undefined;
    return { content: [text(`${header}\nOpened ${app.name}.`)] };
  }

  const target = await this.target(conversationId, app);
  const scale = this.scale(conversationId, app);
  let driverArgs: Record<string, unknown>;
  let driverTool = tool;
  switch (tool) {
    case "screenshot":
      driverTool = "get_app_state";
      driverArgs = { app: target, max_tree_nodes: 1, max_tree_depth: 1 };
      break;
    case "get_app_state":
      driverArgs = { app: target };
      if (args.max_tree_nodes !== undefined)
        driverArgs.max_tree_nodes = Math.min(
          4000,
          Math.max(1, Math.round(num(args.max_tree_nodes, "max_tree_nodes"))),
        );
      if (args.max_tree_depth !== undefined)
        driverArgs.max_tree_depth = Math.min(
          128,
          Math.max(1, Math.round(num(args.max_tree_depth, "max_tree_depth"))),
        );
      break;
    case "click": {
      if (!["left", "right", "middle"].includes(String(button)))
        throw new Refusal("mouse_button must be left, right or middle.");
      const element = optionalIndex(args.element_index);
      const count =
        args.click_count === undefined
          ? 1
          : Math.round(num(args.click_count, "click_count"));
      if (count < 1 || count > 3)
        throw new Refusal("click_count must be 1 to 3.");
      driverArgs = { app: target, mouse_button: button, click_count: count };
      if (element !== undefined) driverArgs.element_index = element;
      else {
        driverArgs.x = num(args.x, "x") * scale;
        driverArgs.y = num(args.y, "y") * scale;
      }
      break;
    }
    case "type_text": {
      if (typeof args.text !== "string" || !args.text)
        throw new Refusal("text is required.");
      if (args.text.length > maxTypedText)
        throw new Refusal(`Type at most ${maxTypedText} characters at a time.`);
      driverArgs = { app: target, text: args.text };
      break;
    }
    case "press_key": {
      const key = str(args.key, "key", 60);
      if (keyBlocked(key))
        throw new Refusal(
          `${key} acts on the whole computer, so computer use doesn't press it.`,
        );
      driverArgs = { app: target, key };
      break;
    }
    case "set_value":
      if (typeof args.value !== "string" || args.value.length > maxTypedText)
        throw new Refusal(`value must be at most ${maxTypedText} characters.`);
      driverArgs = {
        app: target,
        element_index:
          optionalIndex(args.element_index) ?? str(undefined, "element_index"),
        value: args.value,
      };
      break;
    case "scroll": {
      const direction = str(args.direction, "direction", 10);
      if (!["up", "down", "left", "right"].includes(direction))
        throw new Refusal("direction must be up, down, left or right.");
      driverArgs = {
        app: target,
        element_index:
          optionalIndex(args.element_index) ?? str(undefined, "element_index"),
        direction,
      };
      if (args.pages !== undefined)
        driverArgs.pages = Math.min(
          20,
          Math.max(0.1, num(args.pages, "pages")),
        );
      break;
    }
    case "drag":
      driverArgs = {
        app: target,
        from_x: num(args.from_x, "from_x") * scale,
        from_y: num(args.from_y, "from_y") * scale,
        to_x: num(args.to_x, "to_x") * scale,
        to_y: num(args.to_y, "to_y") * scale,
      };
      break;
    case "perform_secondary_action":
      driverArgs = {
        app: target,
        element_index:
          optionalIndex(args.element_index) ?? str(undefined, "element_index"),
        action: str(args.action, "action", 100),
      };
      break;
    default:
      throw new Refusal(`Unknown computer-use tool: ${tool}.`);
  }

  const escape =
    tool === "press_key" &&
    normalizeKey(String(driverArgs.key)).split("+").includes("escape");
  const result = await this.exclusive(async () => {
    if (escape) this.ownEscapeUntil = Infinity;
    try {
      const work = () => this.deps.driver.call(driverTool, driverArgs, mode);
      return await (this.deps.teach?.withClickThrough?.(work) ?? work());
    } finally {
      if (escape) this.ownEscapeUntil = this.now() + 500;
    }
  });
  return this.finish(conversationId, conversation, app, header, tool, result);
}

/** Keeps screenshots, rescales them for the model and adds references. */
export function finish(
  this: ComputerUseBroker,
  conversationId: string,
  conversation: BrokerConversation,
  app: KnownApp,
  header: string,
  tool: string,
  result: ComputerUseToolResult,
): ComputerUseToolResult {
  const content: ComputerUseContent[] = [text(header)];
  for (const item of result.content) {
    if (item.type === "text") {
      // A screenshot needs no accessibility tree.
      if (tool !== "screenshot") content.push(item);
      continue;
    }
    const saved = this.deps.screenshots.save(
      conversationId,
      conversation.incognito,
      Buffer.from(item.data, "base64"),
      item.mimeType,
    );
    let scales = this.scales.get(conversationId);
    if (!scales) this.scales.set(conversationId, (scales = new Map()));
    scales.set(appKey(app.id), saved.scale);
    content.push({
      type: "image",
      data: saved.data,
      mimeType: saved.mimeType,
    });
    content.push(text(screenshotRef(saved.id)));
  }
  return { content, ...(result.isError ? { isError: true } : {}) };
}
