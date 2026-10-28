/**
 * Settings → Claude Code → Pull requests → Branch prefix: 1–40 letters,
 * numbers, ".", "_" or "-", starting with a letter or number, no "..", not
 * ending in "." or ".lock"; and not a name protected branches use.
 */
const shape = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const reserved = new Set(["main", "master", "staging", "warm"]);
const reservedStarts = ["prod-", "release"];

export function branchPrefixProblem(
  value: string,
): "format" | "reserved" | null {
  if (value === "") return null;
  if (
    !shape.test(value) ||
    value.includes("..") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  )
    return "format";
  const lower = value.toLowerCase();
  if (reserved.has(lower) || reservedStarts.some((s) => lower.startsWith(s)))
    return "reserved";
  return null;
}

export const validBranchPrefix = (value: string) =>
  branchPrefixProblem(value) === null;
