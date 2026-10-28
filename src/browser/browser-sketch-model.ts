/**
 * Sketch mode's keys and names. The attachment is "preview-annotation.png" with
 * marks and "preview-screenshot.png" without.
 */
import { isMacPlatform } from "../host/keys";

export type SketchKeyCommand = "undo" | "redo" | "delete" | "deselect";

export interface SketchKeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

export function sketchKeyCommand(
  press: SketchKeyPress,
  platform?: string,
): SketchKeyCommand | undefined {
  if (press.isComposing || press.nativeEvent?.isComposing) return undefined;
  const mac = platform === undefined ? true : isMacPlatform(platform);
  const command = mac
    ? press.metaKey && !press.ctrlKey
    : press.ctrlKey && !press.metaKey;
  const plain = !press.metaKey && !press.ctrlKey && !press.altKey;
  const key = press.key.toLowerCase();
  if (command && !press.altKey && key === "z")
    return press.shiftKey ? "redo" : "undo";
  if (!mac && command && !press.altKey && !press.shiftKey && key === "y")
    return "redo";
  if (plain && !press.shiftKey && (key === "backspace" || key === "delete"))
    return "delete";
  if (plain && !press.shiftKey && key === "escape") return "deselect";
  return undefined;
}

export function sketchAttachmentName(annotated: boolean) {
  return annotated ? "preview-annotation.png" : "preview-screenshot.png";
}

/** A data URL's PNG size, read from its header; undefined for anything else. */
export function pngSize(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, i) => bytes[i] !== value))
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}
