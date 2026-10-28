import type { Item } from "../../shared/types";
import { sanitizeDescription } from "../../shared/tool-description";

/**
 * How a command row words the model's own description (R7). The model writes an
 * imperative sentence ("List repository files"); Chat shows it as is while the
 * command runs and a Code row in the present progressive, in the past tense
 * once it has finished, and as "Failed to …" when it failed. Only the first
 * word changes, and only when it is a known command verb: anything else keeps
 * the model's wording rather than guessing.
 */
export type CommandState = "running" | "completed" | "failed" | "interrupted";

/** Verbs whose past tense is not "-ed" / "-d" / "-ied". */
const irregular: Record<string, string> = {
  begin: "began",
  bring: "brought",
  build: "built",
  checkout: "checked out",
  cut: "cut",
  do: "did",
  draw: "drew",
  feed: "fed",
  find: "found",
  get: "got",
  give: "gave",
  go: "went",
  hold: "held",
  keep: "kept",
  let: "let",
  make: "made",
  output: "output",
  overwrite: "overwrote",
  put: "put",
  read: "read",
  rebuild: "rebuilt",
  reread: "reread",
  rerun: "reran",
  reset: "reset",
  rewrite: "rewrote",
  run: "ran",
  see: "saw",
  seek: "sought",
  send: "sent",
  set: "set",
  show: "showed",
  sleep: "slept",
  spin: "spun",
  split: "split",
  take: "took",
  undo: "undid",
  write: "wrote",
};

/** Verbs that double their last consonant: stop → stopped, commit → committed. */
const doubled = new Set([
  "admit",
  "chop",
  "commit",
  "debug",
  "drop",
  "grep",
  "log",
  "plan",
  "plug",
  "prep",
  "scan",
  "ship",
  "skip",
  "step",
  "stop",
  "strip",
  "submit",
  "tag",
  "unzip",
  "wrap",
  "zip",
]);

/** Regular command verbs the first word may be; other words are left as written. */
const regular = new Set(
  (
    "add allow analyze append apply archive audit benchmark bump calculate " +
    "capture change check clean clear clone close collect compare compile " +
    "compress configure confirm convert copy count create delete deploy " +
    "describe detect determine diff disable display download echo edit enable " +
    "ensure evaluate examine execute explore export extract fetch filter fix " +
    "format gather generate identify import initialize insert inspect install " +
    "kill launch link lint list load locate look measure merge migrate modify " +
    "monitor mount move notarize open package parse patch ping poll preview " +
    "print probe profile publish pull push query rebase record refresh " +
    "register reinstall release remove rename render replace request resize " +
    "restart restore retry revert review revoke save search seed serve sign " +
    "sort stage start stash summarize switch sync tail terminate test tidy " +
    "touch trace truncate try uninstall unlink unmount unstage update upgrade " +
    "upload use validate verify view wait watch"
  ).split(" "),
);

/** Present participles that the -ing rules below get wrong. */
const progressiveIrregular: Record<string, string> = {
  admit: "admitting",
  begin: "beginning",
  checkout: "checking out",
  commit: "committing",
  debug: "debugging",
  format: "formatting",
  rerun: "rerunning",
  reset: "resetting",
  screenshot: "screenshotting",
  snapshot: "snapshotting",
  submit: "submitting",
  sync: "syncing",
  unzip: "unzipping",
};

/** The -ing form of a lower-case verb. */
function progressive(verb: string) {
  if (Object.hasOwn(progressiveIrregular, verb))
    return progressiveIrregular[verb];
  if (/ie$/.test(verb)) return `${verb.slice(0, -2)}ying`;
  if (/[^eoy]e$/.test(verb)) return `${verb.slice(0, -1)}ing`;
  if (
    /[^aeiou][aeiou][bcdfghjklmnpqrstvz]$/.test(verb) &&
    (verb.match(/[aeiou]/g) ?? []).length === 1
  )
    return `${verb}${verb.at(-1)}ing`;
  if (verb.endsWith("c")) return `${verb}king`;
  return `${verb}ing`;
}

function regularPast(verb: string) {
  if (doubled.has(verb)) return `${verb}${verb.at(-1)}ed`;
  if (verb.endsWith("e")) return `${verb}d`;
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ied`;
  return `${verb}ed`;
}

/**
 * The sentence with its first word in the past tense, when that word is a
 * capitalised command verb this table knows ("List files" → "Listed
 * files"); otherwise the sentence unchanged.
 */
export function pastTense(sentence: string): string {
  const match = /^([A-Z][a-z]+)(?=$|[\s,.:;])/.exec(sentence);
  if (!match) return sentence;
  const verb = match[1].toLowerCase();
  const past =
    irregular[verb] ??
    (regular.has(verb) || doubled.has(verb) ? regularPast(verb) : undefined);
  if (!past) return sentence;
  return (
    past.charAt(0).toUpperCase() +
    past.slice(1) +
    sentence.slice(match[1].length)
  );
}

/**
 * The sentence with its first word in the present progressive ("Run tests"
 * → "Running tests"), under the same known-verb rule as `pastTense`.
 */
export function runningTense(sentence: string): string {
  const match = /^([A-Z][a-z]+)(?=$|[\s,.:;])/.exec(sentence);
  if (!match) return sentence;
  const verb = match[1].toLowerCase();
  if (!(verb in irregular || regular.has(verb) || doubled.has(verb)))
    return sentence;
  const now = progressive(verb);
  return (
    now.charAt(0).toUpperCase() + now.slice(1) + sentence.slice(match[1].length)
  );
}

/**
 * "Failed to " and the sentence, first letter lowered when it starts an
 * ordinary capitalised word ("Run tests" → "Failed to run tests"; "NPM
 * install" keeps its case). A sentence that does not start with a Latin
 * letter (another script, a symbol) is shown as written; the row is still red.
 */
function failedSentence(sentence: string) {
  if (!/^[A-Za-z]/.test(sentence)) return sentence;
  const lowered = /^[A-Z][a-z]/.test(sentence)
    ? sentence.charAt(0).toLowerCase() + sentence.slice(1)
    : sentence;
  return `Failed to ${lowered}`;
}

/**
 * The row text for a model-written description in a given state. A Code row
 * words a running command in the present progressive; Chat keeps the
 * model's sentence while it runs.
 */
export function describeCommand(
  description: string,
  state: CommandState,
  progressiveWhileRunning = false,
): string {
  if (state === "completed") return pastTense(description);
  if (state === "failed") return failedSentence(description);
  if (state === "running" && progressiveWhileRunning)
    return runningTense(description);
  return description;
}

/**
 * The row text for a command item's own description, or undefined when it
 * has none (missing, empty after cleaning, or not a command) or was
 * interrupted, which keeps "Command stopped" (R7 default).
 */
export function commandDescriptionText(
  item: Item,
  state: CommandState,
  progressiveWhileRunning = false,
): string | undefined {
  if (item.type !== "commandExecution" || state === "interrupted") return;
  const description = sanitizeDescription(item.description);
  return description
    ? describeCommand(description, state, progressiveWhileRunning)
    : undefined;
}
