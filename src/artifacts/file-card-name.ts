/**
 * The card's title: the file name without its extension, separators as
 * spaces and the first letter capitalised (live claude.ai names
 * first_10_primes.csv "First 10 primes").
 */
export function fileCardName(name: string) {
  const title = name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : name;
}
