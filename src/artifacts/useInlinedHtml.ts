import { useContext, useMemo } from "react";
import type { Artifact } from "../ui/ArtifactTypes";
import { AppContext } from "../app/AppContext";
import { inlineLocalAssets } from "../../shared/inline-assets";

/**
 * An HTML artifact with the stylesheets and scripts the conversation wrote
 * beside it inline, as it previews and as it is published.
 */
export function useInlinedHtml(artifact: Artifact, html: boolean): Artifact {
  const conversation = useContext(AppContext)?.active;
  return useMemo(() => {
    if (!html || !artifact.sourcePath || !conversation) return artifact;
    const files = new Map<string, string>();
    for (const turn of conversation.turns)
      for (const item of turn.items)
        for (const file of item.generatedFiles ?? [])
          if (file.state === "ready" && file.content !== undefined)
            files.set(file.path, file.content);
    const content = inlineLocalAssets(
      artifact.content,
      artifact.sourcePath,
      (path) => files.get(path),
    );
    return content === artifact.content ? artifact : { ...artifact, content };
  }, [html, artifact, conversation]);
}
