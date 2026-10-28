import { useState } from "react";
import { DraftTextStore, useDraftText } from "./draft-text";

/** A draft owned by one component (its own DraftTextStore), for standalone composers. */
export function useSkillDraft(initialText = "") {
  const [store] = useState(() => new DraftTextStore(initialText));
  const draft = useDraftText(store);
  return {
    ...draft,
    setText: store.setText,
    setSkillTokens: store.setSkillTokens,
  };
}
