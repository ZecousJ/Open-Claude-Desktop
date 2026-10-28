/**
 * A command's short form for its row ("Ran git status"), as the original words
 * a command without a description: the first line, leading `cd … &&` steps
 * dropped, at most four plain words, then "…" when anything was left out.
 * Commands whose programs the original does not know, substitutions, flags,
 * addresses and anything that looks like a secret are not shown: the row then
 * says "Ran a command".
 */
const knownPrograms = new Set(
  [
    "bun bunx node npm npx pnpm pnpx yarn deno tsc tsx vitest jest eslint oxlint prettier oxfmt turbo vite next",
    "playwright python python3 pip pip3 uv uvx poetry pytest ruff mypy black go cargo rustc rustup make cmake",
    "bazel gradle mvn swift xcodebuild dotnet git gh docker docker-compose kubectl helm ls cat head tail wc find",
    "fd rg grep sed awk jq tree du stat file diff sort uniq cut tr date sleep which mkdir rm mv cp touch chmod",
    "ln pwd cd get-childitem get-content select-string set-location push-location test-path new-item",
    "remove-item copy-item move-item dir",
  ]
    .join(" ")
    .split(" "),
);
const prefixes = new Set(["time", "nice"]);
const leadingCd =
  /^(?:cd +(?:'[^']*'|"[^"$`\\]*"|[\w./~:+,%-]+) *(?:&&|;) *)+(?=\S)/;
const plainWord = /^(?!-)[A-Za-z0-9._/~:+,@%-]+$/;
const host =
  "(?:[\\w-]+(?:\\.[\\w-]+)*\\.[a-z]{2,}|\\d{1,3}(?:\\.\\d{1,3}){3}|localhost)\\.?";
const address = new RegExp(
  [
    `^${host}(?::[^/]*)?/`,
    `^${host}:\\d+$`,
    "^[\\w-]+(?:\\.[\\w-]+)+\\.:",
    "^[\\w-]+(?:\\.[\\w-]+)*\\.?:\\d+\\/",
    "^//",
  ].join("|"),
  "i",
);
const secretName =
  /^(?:tokens?|passwords?|passwd|secrets?|apikeys?|credentials?)$/i;
const maxWords = 4;

/** Every step's program is one the original names (no substitutions). */
function knownSteps(line: string) {
  if (/\$\(|`|[<>]\(/.test(line)) return false;
  const steps: string[][] = [[]];
  let word = "";
  let quote: string | undefined;
  const end = () => {
    if (word !== "") steps[steps.length - 1].push(word);
    word = "";
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote !== undefined) {
      word += c;
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && next !== undefined) {
        word += next;
        i++;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      word += c;
    } else if (c === "\\" && (next === "'" || next === '"')) {
      word += c + next;
      i++;
    } else if (c === " ") end();
    else if (c === "(" && (word === "" || word === "@")) return false;
    else if (
      c === ";" ||
      c === "|" ||
      (c === "&" && line[i - 1] !== ">" && line[i - 1] !== "<" && next !== ">")
    ) {
      end();
      steps.push([]);
      if (
        (c === "&" && next === "&") ||
        (c === "|" && (next === "|" || next === "&"))
      )
        i++;
    } else word += c;
  }
  end();
  return steps.every((step) => {
    const program = step.find(
      (w) => !/^[A-Za-z_]\w*=/.test(w) && !prefixes.has(w.toLowerCase()),
    );
    if (program === undefined) return true;
    const base = program.split(/[\\/]/).pop() ?? program;
    return knownPrograms.has(base.toLowerCase().replace(/\.exe$/, ""));
  });
}

const tokenLike = (word: string) =>
  (word.match(/[A-Za-z0-9]{20,}/g) ?? []).some(
    (part) => /[A-Za-z]/.test(part) && /\d/.test(part),
  );
const namesSecret = (word: string) => {
  const parts = word.slice(word.lastIndexOf("/") + 1).split(/[-._]/);
  return parts.some(
    (part, i) =>
      secretName.test(part) ||
      (/^api$/i.test(part) && /^keys?$/i.test(parts[i + 1] ?? "")),
  );
};
const emailLike = (word: string) => {
  if (!word.includes("@")) return false;
  if (word.includes(":")) return true;
  const rest = word.replace(/(?:^|\/)@[\w-]+\//g, "/");
  return (
    rest.includes("@") && !/^[^@]+@(?:\d[\w.+~-]*|[A-Za-z][\w-]*)$/.test(rest)
  );
};

export function commandSubject(
  command: string | undefined,
): string | undefined {
  if (command === undefined) return undefined;
  const limit = 8192;
  const text = command.slice(0, limit);
  const start = text.search(/[^ \t\r\n]/);
  if (start === -1) return undefined;
  const newline = text.indexOf("\n", start);
  let line = text
    .slice(start, newline === -1 ? undefined : newline)
    .replace(/\t/g, " ")
    .replace(/[ \r]+$/, "");
  const cut =
    command.length > limit ||
    (newline !== -1 && /[^ \t\r\n]/.test(text.slice(newline)));
  // A continued line ends in a backslash: drop it.
  if (cut && /(?:^|[^\\])(?:\\\\)*\\$/.test(line) && line.at(-2) === " ")
    line = line.slice(0, -1).replace(/[ \r]+$/, "");
  if (line === "" || /[^\S ]/.test(line) || !knownSteps(line)) return undefined;
  const words = line.replace(leadingCd, "").split(/ +/);
  if (newline === -1 && command.length > limit) words.pop();
  const shown: string[] = [];
  for (const word of words) {
    if (
      shown.length === maxWords ||
      !plainWord.test(word) ||
      word.includes("://") ||
      address.test(word) ||
      /%[0-9A-F]{2}/i.test(word) ||
      emailLike(word) ||
      tokenLike(word) ||
      namesSecret(word)
    )
      break;
    shown.push(word);
  }
  if (!shown.length) return undefined;
  const joined = shown.join(" ");
  return cut || shown.length < words.length ? `${joined}…` : joined;
}
