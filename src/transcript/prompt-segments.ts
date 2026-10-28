/** A piece of a typed prompt: plain text, a `code` span or a web address. */
export type PromptSegment = {
  kind: "text" | "code" | "link";
  text: string;
};

// A web address runs to the next whitespace, as in R-0561 where the link
// continues through the CJK text after it; trailing ASCII punctuation that
// usually closes a sentence or a bracket is left out.
const pattern = /`([^`\n]+)`|https?:\/\/[^\s`<>]+/g;
const trailing = /[.,;:!?'")\]}]+$/;

/** Splits a prompt into literal text, inline code and web addresses. */
export function promptSegments(text: string): PromptSegment[] {
  const out: PromptSegment[] = [];
  let last = 0;
  const push = (kind: PromptSegment["kind"], value: string) => {
    if (!value) return;
    const previous = out[out.length - 1];
    if (kind === "text" && previous?.kind === "text") previous.text += value;
    else out.push({ kind, text: value });
  };
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    push("text", text.slice(last, start));
    if (match[1] !== undefined) {
      push("code", match[1]);
      last = start + match[0].length;
      continue;
    }
    const url = match[0].replace(trailing, "");
    push("link", url);
    last = start + url.length;
  }
  push("text", text.slice(last));
  return out;
}
