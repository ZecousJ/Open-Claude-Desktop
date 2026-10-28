import type { RefObject } from "react";
import type { Attachment, Mode } from "../../shared/types";
import type { ComposerField } from "../composer/composer-field";
import { usePlacedDraft, type DraftPlace } from "../composer/draft-store";
import { useDraftText, type DraftTextStore } from "../composer/draft-text";
import { useComposerAutosize } from "./ComposerHost";

/**
 * What follows every edit of the draft, kept out of App so a keystroke does
 * not re-render the window: each conversation's or home's unsent draft is
 * saved and restored, and the composer box keeps its height. Renders nothing.
 */
export function DraftEffects({
  draft,
  owner,
  place,
  attachments,
  setAttachments,
  composer,
  mode,
  activeId,
  textSize,
}: {
  draft: DraftTextStore;
  owner: string;
  place: DraftPlace;
  attachments: Attachment[];
  setAttachments: (attachments: Attachment[]) => void;
  composer: RefObject<ComposerField | null>;
  mode: Mode;
  activeId: string | undefined;
  textSize?: string;
}) {
  const { text, skillTokens } = useDraftText(draft);
  usePlacedDraft({
    owner,
    place,
    text,
    attachments,
    setText: draft.setText,
    setAttachments,
    skillTokens,
    setSkillTokens: draft.setSkillTokens,
  });
  useComposerAutosize(composer, text, mode, activeId, textSize);
  return null;
}
