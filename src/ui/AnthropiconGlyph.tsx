import type { HTMLAttributes } from "react";
import { workspaceIcon } from "./workspace-icons";

const sizes = { xs: 12, sm: 16, md: 20, lg: 24, xl: 28, xxl: 32 };
const strokes = [0.8, 1, 1.2, 1.4, 1.6, 1.8];

export function iconPixels(
  size: number | string,
  comfortable = typeof document === "undefined" ||
    document.documentElement?.dataset?.density !== "compact",
) {
  if (typeof size === "number") return size;
  if (size === "auto") return comfortable ? 20 : 16;
  if (size === "auto-sm") return comfortable ? 16 : 12;
  if (size === "auto-lg") return comfortable ? 24 : 20;
  return sizes[size as keyof typeof sizes] ?? Number.parseFloat(size);
}

export function iconWeight(pixels: number, bold = false) {
  const values = Object.values(sizes);
  const closest = values.reduce((best, next) =>
    Math.abs(next - pixels) <= Math.abs(best - pixels) ? next : best,
  );
  const stroke =
    bold && closest === 16
      ? 1.25
      : bold && closest === 20
        ? 1.5
        : strokes[values.indexOf(closest)];
  const master = pixels <= 18 ? 16 : 20;
  const low = master === 16 ? 0.8 : 1.125;
  const high = master === 16 ? 1.25 : 1.8;
  return (
    Math.round(
      Math.max(
        400,
        Math.min(
          700,
          400 + (300 * ((stroke * master) / pixels - low)) / (high - low),
        ),
      ) * 10,
    ) / 10
  );
}

export function AnthropiconGlyph({ name, size = "md", bold, animated: _animated, ...props }:
  Omit<HTMLAttributes<HTMLSpanElement>, "children"> & { name: string; size?: number | string; bold?: boolean; animated?: boolean }) {
  const Icon = workspaceIcon(name);
  return <span {...props} aria-hidden={props["aria-label"] ? undefined : true}><Icon size={iconPixels(size)} strokeWidth={bold ? 2.4 : 1.8} /></span>;
}
