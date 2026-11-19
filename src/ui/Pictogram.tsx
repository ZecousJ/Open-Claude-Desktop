import { useEffect, useId, useState } from "react";
import "./pictogram.css";

type Path = string | { d: string; fillRule?: "evenodd" | "nonzero" };
interface PictogramDef {
  highlight: Path[];
  line: Path[];
  clip?: string;
  /** The drawing's side when it is not 500 (the lottie ones are 1200). */
  box?: number;
}

/**
 * The original's pictograms (live claude.ai bundle, 2026-10-14,
 * shared-l-m-0 uO): a 500×500 drawing, its highlight in the pictogram
 * colour and its lines in the text colour, 96px at "md". Each loads on
 * first use, as the original's do.
 */
const loaders = {
  HandBlocks: () => import("./pictograms/HandBlocks"),
  HandWriting: () => import("./pictograms/HandWriting"),
  ObjectShapes: () => import("./pictograms/ObjectShapes"),
  ObjectAlert: () => import("./pictograms/ObjectAlert"),
  ObjectPaperAirplane: () => import("./pictograms/ObjectPaperAirplane"),
  ObjectPuzzle: () => import("./pictograms/ObjectPuzzle"),
  ObjectPlugOutlet: () => import("./pictograms/ObjectPlugOutlet"),
  ObjectDocumentAdd: () => import("./pictograms/ObjectDocumentAdd"),
  ObjectMagnifier: () => import("./pictograms/ObjectMagnifier"),
} satisfies Record<string, () => Promise<{ default: PictogramDef }>>;

export type PictogramName = keyof typeof loaders;

const loaded = new Map<PictogramName, PictogramDef>();

const path = (value: Path, key: string, props: object) =>
  typeof value === "string" ? (
    <path key={key} d={value} {...props} />
  ) : (
    <path
      key={key}
      d={value.d}
      fillRule={value.fillRule}
      clipRule={value.fillRule}
      {...props}
    />
  );

export function Pictogram({
  name,
  size = 96,
  className,
}: {
  name: PictogramName;
  size?: number;
  className?: string;
}) {
  const clipId = useId();
  const [def, setDef] = useState(() => loaded.get(name));
  useEffect(() => {
    if (def) return;
    let live = true;
    void loaders[name]().then((module) => {
      loaded.set(name, module.default);
      if (live) setDef(module.default);
    });
    return () => {
      live = false;
    };
  }, [name, def]);
  const body = def && (
    <>
      {def.highlight.map((value, index) =>
        path(value, `h${index}`, { className: "pictogram-highlight" }),
      )}
      {def.line.map((value, index) =>
        path(value, `l${index}`, { fill: "currentColor" }),
      )}
    </>
  );
  return (
    <svg
      className={className ? `pictogram ${className}` : "pictogram"}
      width={size}
      height={size}
      viewBox={`0 0 ${def?.box ?? 500} ${def?.box ?? 500}`}
      fill="none"
      aria-hidden="true"
    >
      {def?.clip ? (
        <>
          <g clipPath={`url(#${clipId})`}>{body}</g>
          <defs>
            <clipPath id={clipId}>
              <path d={def.clip} />
            </clipPath>
          </defs>
        </>
      ) : (
        body
      )}
    </svg>
  );
}
