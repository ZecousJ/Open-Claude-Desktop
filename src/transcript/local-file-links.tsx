import { createContext, useContext } from "react";
import type { Conversation } from "../../shared/types";
import type { Artifact } from "../ui/ArtifactTypes";
import { generatedArtifact } from "../artifacts/generatedArtifact";

/**
 * A reply may link a file it wrote by its path on the agent's computer
 * ("[打开](/…/workspace/pelican.html)"). Such a link opens that file's
 * artifact; a path the conversation never wrote is shown as plain text,
 * never as a link that does nothing.
 */
export type LocalFileResolver = (href: string) => Artifact | undefined;

export const LocalFileLinks = createContext<LocalFileResolver>(() => undefined);

export const useLocalFileLinks = () => useContext(LocalFileLinks);

const normalize = (href: string) => {
  let value = href.trim();
  try {
    value = decodeURI(value);
  } catch {
    // Keep the raw text.
  }
  return value.replace(/^file:\/\//i, "").replace(/[#?].*$/, "");
};

/** The files a conversation's turns wrote, by full path and by name. */
export function localFileResolver(
  conversation: Pick<Conversation, "turns"> | undefined,
): LocalFileResolver {
  const byPath = new Map<string, Artifact>();
  const byName = new Map<string, Artifact>();
  for (const turn of conversation?.turns ?? [])
    for (const item of turn.items)
      for (const file of item.generatedFiles ?? []) {
        const artifact = generatedArtifact(file);
        if (!artifact) continue;
        byPath.set(file.path, artifact);
        byName.set(file.path.split(/[\\/]/).at(-1) ?? file.path, artifact);
      }
  return (href) => {
    const path = normalize(href);
    if (!path) return undefined;
    return (
      byPath.get(path) ??
      (/[\\/]/.test(path) || /\.[a-z0-9]+$/i.test(path)
        ? byName.get(path.split(/[\\/]/).at(-1)!)
        : undefined)
    );
  };
}
