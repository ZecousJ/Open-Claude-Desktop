import { reactComponentInspection } from "./react-inspection";
import { elementDetails } from "./cdp-support";
import type { CdpDriver } from "./cdp";

/**
 * Select element: the page highlights what the pointer is over until the
 * person clicks an element (its details) or `cancelPick` (null).
 */
export async function inspectElement(
  this: CdpDriver,
  selector: string,
  properties?: string[],
) {
  await this.ready();
  try {
    await this.send("DOM.enable");
    await this.send("CSS.enable");
    const root = (await this.send("DOM.getDocument"))?.root?.nodeId;
    const nodeId = (
      await this.send("DOM.querySelector", { nodeId: root, selector })
    )?.nodeId;
    if (!nodeId) return null;
    const node = (await this.send("DOM.describeNode", { nodeId }))?.node;
    const attributes: Record<string, string> = {};
    for (let index = 0; index < (node?.attributes?.length ?? 0); index += 2)
      attributes[node.attributes[index]] = node.attributes[index + 1];
    const computed =
      (await this.send("CSS.getComputedStyleForNode", { nodeId }))
        ?.computedStyle ?? [];
    const wanted = properties ?? [
      "color",
      "background-color",
      "font-size",
      "font-weight",
      "padding",
      "margin",
      "width",
      "height",
      "display",
      "visibility",
    ];
    const styles: Record<string, string> = {};
    for (const property of wanted) {
      const value = computed.find(
        (entry: any) => entry.name === property,
      )?.value;
      if (value !== undefined) styles[property] = value;
    }
    let boundingBox:
      { x: number; y: number; width: number; height: number } | undefined;
    try {
      const quad = (await this.send("DOM.getBoxModel", { nodeId }))?.model
        ?.content;
      if (quad?.length >= 6)
        boundingBox = {
          x: quad[0],
          y: quad[1],
          width: quad[2] - quad[0],
          height: quad[5] - quad[1],
        };
    } catch {}
    const text =
      (
        await this.send("Runtime.evaluate", {
          expression: `document.querySelector(${JSON.stringify(selector)})?.innerText?.substring(0, 500) || ""`,
          returnByValue: true,
        })
      )?.result?.value ?? "";
    let reactComponent: string | undefined;
    let reactProps:
      Record<string, string | number | boolean | null> | undefined;
    const objectGroup = `inspect-element:${nodeId}`;
    try {
      const objectId = (
        await this.send("DOM.resolveNode", { nodeId, objectGroup })
      )?.object?.objectId;
      if (objectId) {
        const result = await this.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: reactComponentInspection,
          arguments: [{ value: { source: false, extent: false } }],
          returnByValue: true,
          awaitPromise: true,
        });
        const component = result?.result?.value;
        if (typeof component?.name === "string" && component.name) {
          reactComponent = component.name.slice(0, 100);
          const props = Object.entries(component.props ?? {})
            .slice(0, 51)
            .filter(
              ([key, value]) =>
                key !== "__proto__" &&
                (value === null ||
                  ["string", "number", "boolean"].includes(typeof value)),
            )
            .map(([key, value]) => [
              key.slice(0, 100),
              typeof value === "string" ? value.slice(0, 201) : value,
            ]);
          if (props.length) reactProps = Object.fromEntries(props);
        }
      }
    } catch {
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup }).catch(
        () => {},
      );
    }
    return {
      tagName: String(node?.nodeName ?? "").toLowerCase(),
      text: String(text).slice(0, 500),
      className: (attributes.class ?? "").slice(0, 200),
      id: attributes.id ?? "",
      value: attributes.value || undefined,
      styles,
      boundingBox,
      reactComponent,
      reactProps,
    };
  } catch {
    return null;
  } finally {
    await this.send("CSS.disable").catch(() => {});
  }
}

export async function pickElement(this: CdpDriver) {
  await this.ready();
  this.pick?.resolve(undefined);
  if (!this.domEnabled) {
    await this.send("DOM.enable");
    await this.send("Overlay.enable");
    this.domEnabled = true;
  }
  const chosen = new Promise<number | undefined>((resolve) => {
    this.pick = { resolve };
  });
  await this.send("Overlay.setInspectMode", {
    mode: "searchForNode",
    highlightConfig: {
      showInfo: true,
      showStyles: false,
      contentColor: { r: 111, g: 168, b: 220, a: 0.45 },
      paddingColor: { r: 147, g: 196, b: 125, a: 0.4 },
      borderColor: { r: 59, g: 130, b: 246, a: 0.9 },
      marginColor: { r: 246, g: 178, b: 107, a: 0.4 },
    },
  });
  const backendNodeId = await chosen;
  await this.send("Overlay.setInspectMode", { mode: "none" }).catch(() => {});
  if (!backendNodeId) return null;
  const ref = this.refFor(backendNodeId);
  const details = await this.callOn(ref, elementDetails);
  if (!details) return null;
  let screenshotPngBase64: string | undefined;
  const box = details.box as { width: number; height: number };
  if (box.width >= 1 && box.height >= 1)
    screenshotPngBase64 = await this.screenshot({ ref })
      .then((shot) => (shot.mimeType === "image/png" ? shot.base64 : undefined))
      .catch(() => undefined);
  return { ...details, ref, screenshotPngBase64 } as {
    selector: string;
    tag: string;
    text: string;
    outerHTML: string;
    styles: Record<string, string>;
    box: { x: number; y: number; width: number; height: number };
    ref: string;
    screenshotPngBase64?: string;
  };
}

/** Ends Select element without a choice. */
export function cancelPick(this: CdpDriver) {
  const pick = this.pick;
  this.pick = undefined;
  pick?.resolve(undefined);
}
