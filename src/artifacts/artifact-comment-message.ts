/**
 * A comment sent to Claude from an artifact (ArtifactHost's
 * sendArtifactComment): `Comment on artifact
 * "<name>":\n<comment>\n\n<context>`. The transcript shows only the comment, as
 * a card with View thread.
 */
export function artifactComment(prompt: string) {
  const match =
    /^Comment on artifact "([^"\n]*)":\n([\s\S]*?)\n\n(?:File: |Artifact content:\n)/.exec(
      prompt,
    );
  return match ? { name: match[1], text: match[2] } : undefined;
}

const threadEvent = "claudex:artifact-thread";

/** View thread: the app opens the named artifact of the conversation. */
export function requestArtifactThread(conversationId: string, name: string) {
  window.dispatchEvent(
    new CustomEvent(threadEvent, { detail: { conversationId, name } }),
  );
}

export function onArtifactThreadRequest(
  listener: (request: { conversationId: string; name: string }) => void,
) {
  const handle = (event: Event) => listener((event as CustomEvent).detail);
  window.addEventListener(threadEvent, handle);
  return () => window.removeEventListener(threadEvent, handle);
}
