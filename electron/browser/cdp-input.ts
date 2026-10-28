import type { BrowserViewport } from "../../shared/browser";
import {
  maxScreenshotSide,
  maxScreenshotBytes,
  describeKey,
  setFieldValue,
  fieldKindScript,
  mobileUserAgent,
  tabletUserAgent,
} from "./cdp-support";
import type { CdpDriver } from "./cdp";
import type { Screenshot, ClickTarget } from "./cdp";

/**
 * A screenshot of the visible page, the whole page, or one element. The
 * longest side is at most 1568 pixels; a PNG over 1.5 MB becomes a JPEG.
 */
export async function screenshot(
  this: CdpDriver,
  options: { fullPage?: boolean; ref?: string } = {},
): Promise<Screenshot> {
  await this.waitForDocument();
  const size = await this.viewportSize();
  let clipRect = {
    x: size.pageX,
    y: size.pageY,
    width: size.width,
    height: size.height,
  };
  if (options.ref) {
    const box = await this.box(options.ref);
    clipRect = {
      x: box.x + size.pageX,
      y: box.y + size.pageY,
      width: Math.max(1, box.width),
      height: Math.max(1, box.height),
    };
  } else if (options.fullPage)
    clipRect = {
      x: 0,
      y: 0,
      width: size.contentWidth,
      height: Math.min(size.contentHeight, 16_384),
    };
  const scale = Math.min(
    1,
    maxScreenshotSide / Math.max(clipRect.width, clipRect.height),
  );
  const ratio = await this.devicePixelRatio();
  const capture = async (format: "png" | "jpeg") =>
    String(
      (
        await this.send("Page.captureScreenshot", {
          format,
          ...(format === "jpeg" ? { quality: 80 } : {}),
          clip: { ...clipRect, scale: scale / ratio },
          captureBeyondViewport: !!options.fullPage,
        })
      )?.data ?? "",
    );
  let base64 = await capture("png");
  let mimeType: Screenshot["mimeType"] = "image/png";
  if ((base64.length * 3) / 4 > maxScreenshotBytes) {
    base64 = await capture("jpeg");
    mimeType = "image/jpeg";
  }
  return {
    mimeType,
    base64,
    width: Math.round(clipRect.width * scale),
    height: Math.round(clipRect.height * scale),
    scale,
  };
}

/** An element's box in viewport CSS pixels, scrolled into view. */
export async function box(this: CdpDriver, ref: string) {
  await this.ready();
  const backendNodeId = this.nodeOf(ref);
  await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(
    () => {},
  );
  let model: any;
  try {
    model = (await this.send("DOM.getBoxModel", { backendNodeId }))?.model;
  } catch {
    throw new Error(`${ref} isn't visible on the page.`);
  }
  const quad: number[] = model?.border ?? model?.content ?? [];
  if (quad.length < 8) throw new Error(`${ref} isn't visible on the page.`);
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export async function point(this: CdpDriver, target: ClickTarget) {
  if ("ref" in target) {
    const box = await this.box(target.ref);
    if (box.width <= 0 || box.height <= 0)
      throw new Error(`${target.ref} has no size on the page.`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y))
    throw new Error("Coordinates must be numbers.");
  return { x: target.x, y: target.y };
}

/** Clicks an element or a point (CSS pixels of the viewport). */
export async function click(
  this: CdpDriver,
  target: ClickTarget,
  options: {
    button?: "left" | "right" | "middle";
    clickCount?: number;
    modifiers?: number;
  } = {},
) {
  await this.ready();
  const { x, y } = await this.point(target);
  const button = options.button ?? "left";
  const clickCount = Math.min(Math.max(options.clickCount ?? 1, 1), 3);
  const modifiers = options.modifiers ?? 0;
  await this.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    modifiers,
  });
  for (let count = 1; count <= clickCount; count++) {
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount: count,
      modifiers,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount: count,
      modifiers,
    });
  }
  return { x, y };
}

export async function hover(this: CdpDriver, target: ClickTarget) {
  await this.ready();
  const { x, y } = await this.point(target);
  await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  return { x, y };
}

/** Scrolls at a point (the middle of the viewport by default). */
export async function scroll(
  this: CdpDriver,
  deltaX: number,
  deltaY: number,
  at?: ClickTarget,
) {
  await this.ready();
  const size = await this.viewportSize();
  const { x, y } = at
    ? await this.point(at)
    : { x: size.width / 2, y: size.height / 2 };
  await this.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: Number(deltaX) || 0,
    deltaY: Number(deltaY) || 0,
  });
}

/** Types text into the focused element. */
export async function type(this: CdpDriver, text: string) {
  await this.ready();
  await this.send("Input.insertText", { text });
}

/** Presses keys: space-separated chords ("cmd+a Backspace"). */
export async function key(this: CdpDriver, keys: string, repeat = 1) {
  await this.ready();
  const platform = this.hooks.platform ?? process.platform;
  const chords = keys
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => describeKey(c, platform));
  for (let i = 0; i < Math.min(Math.max(repeat, 1), 100); i++)
    for (const chord of chords) {
      await this.send("Input.dispatchKeyEvent", {
        type: chord.text ? "keyDown" : "rawKeyDown",
        key: chord.key,
        code: chord.code,
        windowsVirtualKeyCode: chord.keyCode,
        modifiers: chord.modifiers,
        ...(chord.text ? { text: chord.text } : {}),
        ...(chord.commands ? { commands: chord.commands } : {}),
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: chord.key,
        code: chord.code,
        windowsVirtualKeyCode: chord.keyCode,
        modifiers: chord.modifiers,
      });
    }
}

export async function objectOf(this: CdpDriver, ref: string) {
  const backendNodeId = this.nodeOf(ref);
  try {
    const resolved = await this.send("DOM.resolveNode", { backendNodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw new Error("gone");
    return String(objectId);
  } catch {
    throw new Error(
      `${ref} isn't on this page any more. Read the page again for new refs.`,
    );
  }
}

export async function callOn(
  this: CdpDriver,
  ref: string,
  fn: string,
  args: unknown[] = [],
) {
  const objectId = await this.objectOf(ref);
  const result = await this.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.exceptionDetails)
    throw new Error(
      String(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "The page refused.",
      ).replace(/^Error: /, ""),
    );
  return result?.result?.value;
}

/** Sets a form field's value (text, list choice, checkbox) and fires input/change. */
export async function setValue(
  this: CdpDriver,
  ref: string,
  value: string | boolean,
) {
  await this.ready();
  await this.callOn(ref, setFieldValue, [value]);
}

/** What an element is, for approvals (typing into a password field asks every time). */
export async function fieldKind(
  this: CdpDriver,
  ref: string,
): Promise<{ tag: string; type: string; password: boolean }> {
  await this.ready();
  return (
    (await this.callOn(ref, fieldKindScript)) ?? {
      tag: "",
      type: "",
      password: false,
    }
  );
}

/** Whether the focused element is a password field. */
export async function focusedIsPassword(this: CdpDriver) {
  await this.ready();
  const result = await this.send("Runtime.evaluate", {
    expression:
      "(() => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return !!el && el instanceof HTMLInputElement && el.type === 'password'; })()",
    returnByValue: true,
  });
  return result?.result?.value === true;
}

/**
 * The phone viewport: touch, a phone's user agent and mobile layout (the
 * panel narrows the page to the phone's width). `desktopUserAgent` is
 * restored for "desktop". The page reloads so it sees the new agent.
 */
export async function setViewport(
  this: CdpDriver,
  viewport: BrowserViewport,
  desktopUserAgent: string,
) {
  await this.ready();
  if (typeof viewport === "object") {
    await this.send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await this.send("Emulation.setUserAgentOverride", {
      userAgent: desktopUserAgent,
    });
    return;
  }
  if (viewport !== "desktop") {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: 0,
      mobile: true,
    });
    await this.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    await this.send("Emulation.setUserAgentOverride", {
      userAgent: viewport === "tablet" ? tabletUserAgent : mobileUserAgent,
      platform: viewport === "tablet" ? "iPad" : "iPhone",
    });
  } else {
    await this.send("Emulation.clearDeviceMetricsOverride");
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await this.send("Emulation.setUserAgentOverride", {
      userAgent: desktopUserAgent,
    });
  }
}

/** The prefers-color-scheme the page sees; "system" leaves the app's own. */
export async function setColorScheme(
  this: CdpDriver,
  scheme: "system" | "light" | "dark",
) {
  await this.ready();
  await this.send("Emulation.setEmulatedMedia", {
    features: [
      {
        name: "prefers-color-scheme",
        value: scheme === "system" ? "" : scheme,
      },
    ],
  });
}
