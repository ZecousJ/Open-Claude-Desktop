/**
 * Claude's `<pr-created>` tag in a reply: the tag is for the branch row, which
 * binds to the address inside it (shared/pull-request.ts); the transcript shows
 * the address as a link.
 */
const prCreated = /<pr-created>\s*(https?:\/\/[^\s<]+?)\s*<\/pr-created>/gi;
const wordCharacter = /[A-Za-z0-9_-]/;
/** A tag that has not closed yet (the reply is still streaming). */
const openPrCreated = /(^|\n)<pr-created>[^]*$/i;

/** The reply with each tag replaced by its address, and an open tag dropped. */
export function withoutPrTags(text: string) {
  if (!text.includes("<pr-created")) return text;
  return text
    .replace(prCreated, (match, url: string, offset: number, all: string) => {
      const next = all[offset + match.length];
      return next !== undefined &&
        wordCharacter.test(next) &&
        wordCharacter.test(url[url.length - 1])
        ? `${url} `
        : url;
    })
    .replace(openPrCreated, "$1")
    .trimEnd();
}
