import { useContext, useEffect, useState, type ComponentType } from "react";
import { Shuffle, ChevronRight, X } from "../ui/glyphs";
import { AppContext } from "../app/AppContext";
import { t } from "../i18n";
import { setPromptPreview } from "../composer/prompt-preview";
import {
  BriefingIdeaIcon,
  CustomizeIdeaIcon,
  FileIdeaIcon,
  InboxIdeaIcon,
  OrganizeIdeaIcon,
} from "../home/CoworkIdeaIcons";
import {
  coworkIdeaCategories,
  coworkIdeasHidden,
  hideCoworkIdeas,
  nextIdeaCategory,
  type CoworkIdeaThumbnail,
} from "./cowork-ideas";
import "./cowork-ideas.css";

const thumbnails: Record<CoworkIdeaThumbnail, ComponentType> = {
  prep: BriefingIdeaIcon,
  comms: InboxIdeaIcon,
  skill: CustomizeIdeaIcon,
  organize: OrganizeIdeaIcon,
  file: FileIdeaIcon,
};

const storage = () => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

/**
 * The ideas under the Cowork home's composer: a heading whose shuffle button
 * names the set and steps to the next one, an X that hides the ideas for good
 * (shown while the ideas are pointed at or focused), three rows that each
 * preview their prompt in the composer and fill it when clicked, with a caret
 * on hover, and "Customize with plugins" under them, which opens the Plugins
 * page. Self-contained, with its own styles, so the home can place it wherever
 * its layout puts the ideas.
 */
export default function CoworkIdeas({
  onPick,
}: {
  /** Puts an idea's (translated) prompt in the composer. */
  onPick: (prompt: string) => void;
}) {
  const app = useContext(AppContext);
  const [hidden, setHidden] = useState(() => coworkIdeasHidden(storage()));
  // Each visit starts at the first set, as the live list does.
  const [index, setIndex] = useState(0);
  // A suggestion's preview never outlives the ideas.
  useEffect(() => () => setPromptPreview(null), []);
  if (hidden) return null;
  const category = coworkIdeaCategories[index] ?? coworkIdeaCategories[0]!;
  const hide = () => {
    setPromptPreview(null);
    hideCoworkIdeas(storage());
    setHidden(true);
  };
  return (
    <div className="cowork-ideas">
      <div className="cowork-ideas-head">
        <button
          type="button"
          className="cowork-ideas-shuffle"
          onClick={() => {
            setPromptPreview(null);
            setIndex(nextIdeaCategory(index));
          }}
        >
          <Shuffle size={20} strokeWidth={1.5} aria-hidden="true" />
          <span>{category.name}</span>
        </button>
        <button
          type="button"
          className="cowork-ideas-hide"
          aria-label="Hide suggestions"
          onClick={hide}
        >
          <X size={14} />
        </button>
      </div>
      {category.ideas.map(({ id, thumbnail, label, prompt }) => {
        const Icon = thumbnails[thumbnail];
        return (
          // Pointed at or focused, an idea previews its prompt in the
          // composer (the original's suggestion hover preview).
          <button
            key={`${category.id}:${id}`}
            type="button"
            className="cowork-idea"
            onPointerEnter={() => setPromptPreview(t(prompt))}
            onPointerLeave={() => setPromptPreview(null)}
            onFocus={() => setPromptPreview(t(prompt))}
            onBlur={() => setPromptPreview(null)}
            onClick={() => {
              setPromptPreview(null);
              onPick(t(prompt));
            }}
          >
            <Icon />
            <span>{label}</span>
            <small>Cowork</small>
            <ChevronRight className="cowork-idea-caret" size={16} />
          </button>
        );
      })}
      {app && (
        <button
          type="button"
          className="cowork-ideas-plugins"
          onClick={() => app.openSettingsTab("plugins")}
        >
          Customize with plugins
        </button>
      )}
    </div>
  );
}
