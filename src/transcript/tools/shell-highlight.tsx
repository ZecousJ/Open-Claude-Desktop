import type { ReactNode } from "react";

export type ShellTokenKind =
  | "plain"
  | "space"
  | "comment"
  | "string"
  | "variable"
  | "operator"
  | "keyword"
  | "command"
  | "number"
  | "arg"
  | "list";
export interface ShellToken {
  kind: ShellTokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "in",
  "do",
  "done",
  "while",
  "until",
  "case",
  "esac",
  "function",
  "select",
  "time",
]);
// Keywords after which the next word starts a new command.
const COMMAND_AFTER = new Set([
  "then",
  "else",
  "elif",
  "do",
  "if",
  "while",
  "until",
  "time",
  "!",
]);
const SEPARATORS = new Set([
  ";",
  "|",
  "||",
  "&&",
  "&",
  "(",
  "$(",
  "`",
  "{",
  "\n",
  ";;",
]);

/** Small shell lexer for command cards. It only colors; it never interprets the command. */
export function tokenizeShell(source: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;
  const push = (kind: ShellTokenKind, text: string) => {
    if (text) tokens.push({ kind, text });
  };
  while (i < source.length) {
    const rest = source.slice(i);
    const ch = source[i];
    let match: RegExpMatchArray | null;
    if ((match = rest.match(/^[ \t]+/))) {
      push("space", match[0]);
      i += match[0].length;
      continue;
    }
    if (ch === "\n") {
      push("operator", "\n");
      i++;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(source[i - 1]))) {
      const end = source.indexOf("\n", i);
      const text = end < 0 ? rest : source.slice(i, end);
      push("comment", text);
      i += text.length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch)
        j += ch === '"' && source[j] === "\\" ? 2 : 1;
      const text = source.slice(i, Math.min(j + 1, source.length));
      push("string", text);
      i += text.length;
      continue;
    }
    if (
      (match = rest.match(
        /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])/,
      ))
    ) {
      push("variable", match[0]);
      i += match[0].length;
      continue;
    }
    if (
      (match = rest.match(
        /^(?:[0-9]*[<>]&[0-9-]+|&&|\|\||;;|\$\(|[;|&()<>{}`]|\[\[?|\]\]?|[0-9]*>>?|<<)/,
      ))
    ) {
      push("operator", match[0]);
      i += match[0].length;
      continue;
    }
    if ((match = rest.match(/^[^\s;|&()<>`'"$]+/))) {
      push("plain", match[0]);
      i += match[0].length;
      continue;
    }
    push("plain", ch);
    i++;
  }
  // Classify words by position.
  let commandPosition = true,
    inList = false,
    afterFor = false;
  for (const token of tokens) {
    if (token.kind === "space" || token.kind === "comment") continue;
    if (token.kind === "operator") {
      if (SEPARATORS.has(token.text)) {
        commandPosition = true;
        inList = false;
      }
      continue;
    }
    if (token.kind !== "plain") {
      commandPosition = false;
      continue;
    }
    if (
      KEYWORDS.has(token.text) &&
      (commandPosition ||
        (token.text === "in" && afterFor) ||
        token.text === "do" ||
        token.text === "done")
    ) {
      token.kind = "keyword";
      inList = token.text === "in" && afterFor;
      afterFor = token.text === "for" || token.text === "select";
      commandPosition = COMMAND_AFTER.has(token.text);
      continue;
    }
    if (afterFor) {
      token.kind = "arg";
      continue;
    }
    if (inList) {
      token.kind = "list";
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.text) && commandPosition) {
      token.kind = "arg";
      continue;
    }
    if (commandPosition) {
      token.kind = "command";
      commandPosition = false;
      continue;
    }
    token.kind = /^-?\d+(?:\.\d+)?$/.test(token.text) ? "number" : "arg";
  }
  return tokens;
}

export function ShellSource({ source }: { source: string }): ReactNode {
  return tokenizeShell(source).map((token, index) =>
    token.kind === "space" || token.kind === "plain" ? (
      token.text
    ) : (
      <span key={index} className={`sh-${token.kind}`}>
        {token.text}
      </span>
    ),
  );
}
