import {
  deviceLabel,
  setupReady,
  simulatorKindLabel,
  simulatorNoun,
  simulatorTextLimit,
  simulatorAutoModeNote,
  type SimulatorDevice,
  type SimulatorKind,
} from "../../shared/simulators";
import { SimulatorError, type TouchPoint } from "./driver";
import { pngSize } from "./png";
import {
  text,
  modelImageEdge,
  fitWithin,
  setupProblem,
} from "./service-support";
import type { SimulatorService } from "./service";
import type { ControlArgs, ControlResult } from "./service";

/** The screen as Claude sees it, and how its coordinates map to the device. */
export async function look(
  this: SimulatorService,
  kind: SimulatorKind,
  device: SimulatorDevice,
) {
  const driver = this.driver(kind);
  const png = await driver.screenshot(device.id);
  const size = pngSize(png);
  if (!size)
    throw new SimulatorError(
      `${simulatorKindLabel[kind]} screenshot failed: the captured image could not be decoded. Try taking the screenshot again; if this persists, detach and re-attach the ${simulatorNoun[kind]}.`,
    );
  this.shots.set(`${kind}:${device.id}`, size);
  const space = await driver.inputSpace(device.id, png);
  // iOS screenshots are drawn at the device's size in points, so a
  // position in the picture is a position on the device.
  const target =
    kind === "ios" && space ? space : fitWithin(size, modelImageEdge);
  const image = this.deps.scaler(png, target);
  if (space)
    this.views.set(`${kind}:${device.id}`, {
      space,
      image: { width: image.width, height: image.height },
    });
  return { image, space };
}

export async function viewOf(
  this: SimulatorService,
  kind: SimulatorKind,
  device: SimulatorDevice,
) {
  return (
    this.views.get(`${kind}:${device.id}`) ??
    (await this.look(kind, device).then(() =>
      this.views.get(`${kind}:${device.id}`),
    ))
  );
}

/** "Coordinate space for tap/swipe: …" for attach and launch. */
export async function spaceNote(
  this: SimulatorService,
  kind: SimulatorKind,
  device: SimulatorDevice,
) {
  try {
    const { image, space } = await this.look(kind, device);
    if (kind === "ios")
      return space
        ? `Coordinate space for tap/swipe: ${space.width}x${space.height} points (origin top-left).`
        : "Tapping needs Facebook idb, which isn't installed; screenshots work without it.";
    return `Coordinate space for screenshot/tap/swipe: ${image.width}x${image.height} pixels (origin top-left).`;
  } catch {
    return "Coordinate space could not be determined. Take a screenshot; its result states its dimensions.";
  }
}

/** Maps a position in Claude's screenshot to the device. */
export async function toDevice(
  this: SimulatorService,
  kind: SimulatorKind,
  device: SimulatorDevice,
  x: number | undefined,
  y: number | undefined,
  name = "x/y",
) {
  if (
    x === undefined ||
    y === undefined ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  )
    throw new SimulatorError(`This action requires ${name}.`);
  const view = await this.viewOf(kind, device);
  if (!view)
    throw new SimulatorError(
      "Coordinate space could not be determined. Take a screenshot first.",
    );
  if (x < 0 || y < 0 || x > view.image.width || y > view.image.height)
    throw new SimulatorError(
      `The position (${Math.round(x)}, ${Math.round(y)}) is outside the ${view.image.width}x${view.image.height} screen.`,
    );
  return {
    x: (x * view.space.width) / view.image.width,
    y: (y * view.space.height) / view.image.height,
  };
}

/** Claude's `control` call for one kind of device. */
export async function control(
  this: SimulatorService,
  kind: SimulatorKind,
  conversationId: string,
  args: ControlArgs,
): Promise<ControlResult> {
  const refused = this.unavailable(kind);
  if (refused) return text(refused, false);
  try {
    const result = await this.perform(kind, conversationId, args);
    const device = this.current.get(`${conversationId}:${kind}`);
    const key = `${conversationId}:${kind}:${device}`;
    if (
      result.success &&
      device &&
      this.autoConversations.has(conversationId) &&
      !this.autoNotices.has(key)
    ) {
      this.autoNotices.add(key);
      const found = (await this.driver(kind).list()).find(
        (item) => item.id === device || item.avd === device,
      );
      result.parts.unshift({
        type: "text",
        text: simulatorAutoModeNote.replace(
          "{device}",
          deviceLabel(found?.name ?? device),
        ),
      });
    }
    return result;
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), false);
  }
}

export async function perform(
  this: SimulatorService,
  kind: SimulatorKind,
  conversationId: string,
  args: ControlArgs,
): Promise<ControlResult> {
  const driver = this.driver(kind);
  const setup = await this.setupCached(kind);
  if (!setupReady(kind, setup)) return text(setupProblem(kind, setup), false);
  const slot = `${conversationId}:${kind}`;
  if (args.action === "detach") {
    const held = this.current.get(slot);
    if (held) await this.restoreNetwork(kind, held);
    this.current.delete(slot);
    return text(`Detached the ${simulatorNoun[kind]}.`);
  }
  let device = await this.resolve(
    kind,
    conversationId,
    args.device,
    args.action,
  );
  const label = deviceLabel(device.name);
  const answer = await this.ensureAccess(
    kind,
    device,
    this.autoConversations.has(conversationId),
  );
  if (answer !== "granted")
    return text(
      answer === "declined"
        ? `The user declined to let Claudex use ${label}. Don't try again unless they ask.`
        : answer === "timeout"
          ? `The user didn't answer the request to use ${label}. Ask them to answer it before you try again.`
          : `Access to ${label} was asked for or declined a moment ago. Wait for the user before trying again.`,
      false,
    );
  if (device.state === "shutdown" || device.state === "booting") {
    if (args.action !== "attach" && args.action !== "launch")
      return text(
        `${label} is ${device.state === "shutdown" ? "shut down" : "booting"}. Attach it first.`,
        false,
      );
    device = await driver.boot(device.id);
  }
  if (device.state !== "booted")
    return text(
      `${label} is ${device.state}. Boot it before attaching.`,
      false,
    );
  this.current.set(slot, device.avd ?? device.id);
  const id = device.id;
  switch (args.action) {
    case "attach":
      return text(
        `Attached to ${label}${device.osVersion ? ` (${device.osVersion})` : ""}. ${await this.spaceNote(kind, device)}`,
      );
    case "launch": {
      if (!args.app_path) return text("'launch' requires app_path.", false);
      const launched = await driver.launch(id, args.app_path, args.bundle_id);
      this.deps.onLaunch?.(kind, id, launched.appId);
      return text(
        `Launched ${launched.appId} on ${label}. ${await this.spaceNote(kind, device)}`,
      );
    }
    case "screenshot": {
      const { image, space } = await this.look(kind, device);
      const note =
        kind === "ios"
          ? space
            ? `Screenshot: ${image.width}x${image.height} points from ${label}. Tap/swipe coordinates are in this image's space.`
            : `Screenshot: ${image.width}x${image.height} pixels from ${label}. Tapping needs Facebook idb, which isn't installed.`
          : `Screenshot: ${image.width}x${image.height} from ${label}. Tap/swipe coordinates are in this image's pixel space.`;
      return {
        success: true,
        parts: [
          { type: "image", image },
          { type: "text", text: note },
        ],
      };
    }
    case "tap": {
      const at = await this.toDevice(kind, device, args.x, args.y);
      await driver.tap(id, at.x, at.y, args.duration);
      return text(
        args.duration && args.duration > 0.5 ? "Long-pressed." : "Tapped.",
      );
    }
    case "swipe": {
      const from = await this.toDevice(
        kind,
        device,
        args.x,
        args.y,
        "x, y, x2, y2",
      );
      const to = await this.toDevice(
        kind,
        device,
        args.x2,
        args.y2,
        "x, y, x2, y2",
      );
      await driver.swipe(id, from, to, args.duration ?? 0.3);
      return text("Swiped.");
    }
    case "touch_path": {
      if (!args.points || args.points.length < 2)
        return text("'touch_path' requires at least 2 points.", false);
      const points: TouchPoint[] = [];
      let waited = 0;
      for (const point of args.points.slice(0, 256)) {
        const at = await this.toDevice(
          kind,
          device,
          point.x,
          point.y,
          "points",
        );
        const dtMs = Math.min(
          Math.max(point.dt_ms ?? 0, 0),
          1000,
          30_000 - waited,
        );
        waited += dtMs;
        points.push({ ...at, dtMs });
      }
      await driver.touchPath(id, points);
      return text(
        kind === "ios"
          ? "Dragged from the first point to the last (the iOS Simulator follows a straight swipe, not the path in between)."
          : "Touch path done.",
      );
    }
    case "text": {
      if (args.text === undefined || args.text === "")
        return text("'text' requires text.", false);
      const result = await driver.text(
        id,
        args.text.slice(0, simulatorTextLimit),
      );
      return text(
        result.dropped
          ? `Typed ${result.typed} characters; ${result.dropped} unsupported character${result.dropped === 1 ? " was" : "s were"} dropped.`
          : `Typed ${result.typed} characters.`,
      );
    }
    case "button": {
      if (!args.name) return text("'button' requires name.", false);
      await driver.button(id, args.name);
      return text(`Pressed ${args.name}.`);
    }
    case "open_url": {
      if (!args.url) return text("'open_url' requires url.", false);
      try {
        new URL(args.url);
      } catch {
        return text(
          "'open_url' needs a full URL (for example https://example.com).",
          false,
        );
      }
      await driver.openUrl(id, args.url);
      return text(`Opened ${args.url.slice(0, 200)}.`);
    }
    case "airplane_mode": {
      if (!driver.airplaneMode)
        return text(
          "'airplane_mode' works on the Android emulator only.",
          false,
        );
      if (args.state !== "on" && args.state !== "off")
        return text("'airplane_mode' requires state: 'on' or 'off'.", false);
      const on = args.state === "on";
      if ((await driver.airplaneMode(id)) === on)
        return text(
          `Airplane mode was already ${args.state} for ${label}, so Claudex left it ${args.state}.`,
        );
      await driver.airplaneMode(id, on);
      if (on) this.airplaneOn.add(`${kind}:${device.avd ?? id}`);
      else this.airplaneOn.delete(`${kind}:${device.avd ?? id}`);
      return text(
        on
          ? `Turned airplane mode on for ${label}. Within about 10 seconds, apps on it can no longer reach the internet or this computer at 10.0.2.2, until you call 'airplane_mode' with state 'off'.`
          : `Turned airplane mode off for ${label}. The network comes back within about 10 seconds.`,
      );
    }
    default:
      return text(`Unknown action '${args.action}'.`, false);
  }
}
