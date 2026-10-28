import { useContext, useLayoutEffect, useRef, type RefObject } from "react";
import type { SkillToken } from "./skill-tokens";
import { callableSkills } from "./skill-tokens";
import { AppContext } from "../app/AppContext";
import { useAddMenuResource } from "./useAddMenuResource";
import { SkillReference } from "./SkillReference";
import "./skill-token-mirror.css";

const readSkills = (bridge: Window["desktop"]) => bridge.customizeSkills();

/** Real `$name` references remain textarea text; this layer colors their
 * atomic ranges like O16 shared9's inline text-accent skill node. */
export function SkillTokenMirror({
  text,
  tokens,
  field,
}: {
  text: string;
  tokens: readonly SkillToken[];
  field: RefObject<HTMLElement | null>;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const app = useContext(AppContext);
  const inventory = useAddMenuResource(readSkills, app?.accountId ?? "local");
  const skills = callableSkills(inventory.rows);
  useLayoutEffect(() => {
    const area = field.current,
      copy = mirror.current;
    if (!area || !copy) return;
    const sync = () => {
      const style = getComputedStyle(area);
      copy.style.font = style.font;
      copy.style.lineHeight = style.lineHeight;
      copy.style.letterSpacing = style.letterSpacing;
      copy.style.padding = style.padding;
      copy.style.paddingRight = `${area.offsetWidth - area.clientWidth + (parseFloat(style.paddingRight) || 0)}px`;
      copy.scrollTop = area.scrollTop;
      copy.scrollLeft = area.scrollLeft;
    };
    sync();
    area.addEventListener("scroll", sync);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(sync);
    observer?.observe(area);
    return () => {
      area.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  });
  let at = 0;
  const parts = tokens.flatMap((token) => {
    const before = text.slice(at, token.start);
    at = token.end;
    const skill = skills.find((value) => value.name === token.name);
    return [
      <span key={`text-${token.start}`} aria-hidden="true">
        {before}
      </span>,
      skill ? (
        <SkillReference
          key={token.start}
          name={token.name}
          description={skill.description}
          raw={text.slice(token.start, token.end)}
        />
      ) : (
        <span key={token.start} aria-hidden="true">
          {text.slice(token.start, token.end)}
        </span>
      ),
    ];
  });
  return (
    <div ref={mirror} className="composer-skill-mirror" data-no-translate>
      {parts}
      <span aria-hidden="true">
        {text.slice(at)}
        {"\u200b"}
      </span>
    </div>
  );
}
