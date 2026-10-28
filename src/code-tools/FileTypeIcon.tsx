import { createElement, useEffect, useState, type ReactNode } from "react";

/**
 * The @pierre/trees "complete" icon set, loaded when first needed so it stays
 * out of the first load. A name matches the set's file names first, then its
 * extensions from the longest ("a.test.ts" tries "test.ts", then "ts");
 * anything else gets the set's default file. Colours come from the set's
 * palette, one for each theme. 16px, the "sm" size.
 */
type Node = [string, Record<string, string>, Node[]?];
type IconSet = {
  defaultIcon: string;
  palette: Record<string, [string, string]>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  icons: Record<string, string>;
};

let set: IconSet | undefined;
let loading: Promise<void> | undefined;
const waiting = new Set<() => void>();
function load() {
  loading ??= import("./file-icons.json").then(
    (module) => {
      set = (module.default ?? module) as unknown as IconSet;
      for (const done of waiting) done();
      waiting.clear();
    },
    () => {
      // Without the set the row keeps its plain file glyph.
    },
  );
  return loading;
}

function iconName(icons: IconSet, path: string) {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  if (Object.hasOwn(icons.fileNames, name)) return icons.fileNames[name];
  for (let at = name.indexOf("."); at !== -1; at = name.indexOf(".", at + 1)) {
    const extension = name.slice(at + 1);
    if (Object.hasOwn(icons.fileExtensions, extension))
      return icons.fileExtensions[extension];
  }
  return icons.defaultIcon;
}

const attributes: Record<string, string> = {
  d: "d",
  fill: "fill",
  opacity: "opacity",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  stroke: "stroke",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-miterlimit": "strokeMiterlimit",
  "stroke-dasharray": "strokeDasharray",
  transform: "transform",
  x: "x",
  y: "y",
  width: "width",
  height: "height",
  cx: "cx",
  cy: "cy",
  r: "r",
  rx: "rx",
  ry: "ry",
};
const tags = new Set(["g", "path", "circle", "ellipse", "rect"]);

function render(
  nodes: Node[],
  palette: IconSet["palette"],
  dark: boolean,
): ReactNode[] {
  return nodes
    .filter(([tag]) => tags.has(tag))
    .map(([tag, attrs, children], index) => {
      const props: Record<string, string | number> = { key: index };
      for (const [name, value] of Object.entries(attrs)) {
        const prop = attributes[name];
        if (!prop) continue;
        props[prop] = value.startsWith("$")
          ? (palette[value.slice(1)]?.[dark ? 1 : 0] ?? "currentColor")
          : value;
      }
      return createElement(
        tag,
        props,
        children ? render(children, palette, dark) : undefined,
      );
    });
}

function isDark() {
  return (
    typeof document === "undefined" ||
    document.documentElement.dataset.theme !== "light"
  );
}

export function FileTypeIcon({
  path,
  fallback,
}: {
  path: string;
  /** Shown until the set arrives (or if it cannot load). */
  fallback?: ReactNode;
}) {
  const [, setLoaded] = useState(Boolean(set));
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    if (set) return;
    const done = () => setLoaded(true);
    waiting.add(done);
    void load();
    return () => void waiting.delete(done);
  }, []);
  useEffect(() => {
    const Observer = document.defaultView?.MutationObserver;
    if (!Observer) return;
    const observer = new Observer(() => setDark(isDark()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  if (!set) return <>{fallback ?? null}</>;
  const name = iconName(set, path);
  const source = set.icons[name] ?? set.icons[set.defaultIcon];
  let nodes: Node[] = [];
  try {
    nodes = JSON.parse(source) as Node[];
  } catch {
    return <>{fallback ?? null}</>;
  }
  return (
    <svg
      className="file-type-icon"
      data-file-type-icon=""
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
    >
      {render(nodes, set.palette, dark)}
    </svg>
  );
}
