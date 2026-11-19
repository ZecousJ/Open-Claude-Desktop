import type { SVGProps } from "react";
import { iconPixels } from "./AnthropiconGlyph";
import { workspaceIcon } from "./workspace-icons";

export type AnthropiconName = string;

export function Anthropicon({ name, size = 16, animated: _animated, bold, strokeWidth, ...props }:
  Omit<SVGProps<SVGSVGElement>, "name" | "size"> & { name: AnthropiconName; size?: number | string; animated?: boolean; bold?: boolean }) {
  const Icon = workspaceIcon(name);
  return <Icon aria-hidden="true" {...props} size={iconPixels(size)} strokeWidth={strokeWidth ?? (bold ? 2.4 : 1.8)} />;
}
