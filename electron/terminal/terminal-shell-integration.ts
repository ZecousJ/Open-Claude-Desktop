import fs from "node:fs";
import path from "node:path";

/**
 * How a terminal tab knows a command is running in it: the shell is started
 * with a few hooks that print the standard prompt marks (OSC 133, as terminals
 * with shell integration use them) around every command, and the main process
 * reads the marks off the tab's output. The official Code terminal asks "Close
 * terminal?" only while a command is still running in the tab; Codex runs the
 * tab's shell for us, so its process tree is out of reach and the marks are
 * what tell.
 *
 * - zsh: ZDOTDIR points at a folder whose .zshenv and .zshrc read the user's
 *   own files first, then add a preexec and a precmd hook.
 * - bash: --rcfile reads ~/.bashrc first, then PROMPT_COMMAND marks the prompt
 *   and PS0 (bash 4.4+) or a DEBUG trap (older bash) the command.
 * - fish: --init-command adds fish_preexec and fish_postexec handlers.
 * - Command Prompt: PROMPT starts with the prompt mark, and a line entered at
 *   the prompt counts as a running command until the next prompt.
 * - Any other shell prints no marks, and its tabs never ask.
 *
 * xterm ignores OSC 133, so the marks never show on screen.
 */

/** The program a terminal tab runs, its title and what its environment adds. */
export interface TerminalShell {
  command: string[];
  title: string;
  /** The ShellOption it was chosen as (this computer's shells). */
  id?: string;
  /** Environment variables the shell gets on top of the inherited ones. */
  env?: Record<string, string>;
}

export type ShellKind = "zsh" | "bash" | "fish" | "cmd";

/** Which shell a program is, by its file name ("/bin/zsh", "cmd.exe"). */
export function shellKind(program: string): ShellKind | undefined {
  const name = program
    .split(/[\\/]/)
    .at(-1)!
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "zsh" || name === "bash" || name === "fish" || name === "cmd")
    return name;
}

const PROMPT_MARK = "\\e]133;D;%s\\a";
const COMMAND_MARK = "\\e]133;C\\a";

/** Read by zsh first; puts the user's .zshenv in front of ours. */
export const ZSHENV = `# Claudex terminal: marks the start and end of every command (OSC 133).
__claudex_zdotdir="$ZDOTDIR"
ZDOTDIR="\${CLAUDEX_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshenv" ]] && builtin source "$ZDOTDIR/.zshenv"
if [[ -n "\${CLAUDEX_USER_ZDOTDIR-}" || "$ZDOTDIR" != "$HOME" ]]; then
  __claudex_user_zdotdir="$ZDOTDIR"
else
  __claudex_user_zdotdir=
fi
ZDOTDIR="$__claudex_zdotdir"
unset __claudex_zdotdir CLAUDEX_USER_ZDOTDIR
`;

/** Puts the user's ZDOTDIR back, reads their .zshrc, then adds the hooks. */
export const ZSHRC = `# Claudex terminal: marks the start and end of every command (OSC 133).
__claudex_zdotdir="$ZDOTDIR"
if [[ -n "$__claudex_user_zdotdir" ]]; then
  ZDOTDIR="$__claudex_user_zdotdir"
else
  unset ZDOTDIR
fi
# /etc/zshrc named the history file after our folder; it is the user's.
if [[ "\${HISTFILE-}" == "$__claudex_zdotdir/.zsh_history" ]]; then
  HISTFILE="\${ZDOTDIR:-$HOME}/.zsh_history"
fi
unset __claudex_user_zdotdir __claudex_zdotdir
[[ -r "\${ZDOTDIR:-$HOME}/.zshrc" ]] && builtin source "\${ZDOTDIR:-$HOME}/.zshrc"
__claudex_preexec() { builtin printf '${COMMAND_MARK}'; }
__claudex_precmd() { builtin printf '${PROMPT_MARK}' "$?"; }
builtin autoload -Uz add-zsh-hook
add-zsh-hook preexec __claudex_preexec
add-zsh-hook precmd __claudex_precmd
if [[ -n "\${CLAUDEX_SI_TMP-}" ]]; then
  command rm -f -- "$CLAUDEX_SI_TMP/.zshenv" "$CLAUDEX_SI_TMP/.zshrc"
  command rmdir -- "$CLAUDEX_SI_TMP" 2>/dev/null
fi
unset CLAUDEX_SI_TMP
`;

/** bash's --rcfile: the user's ~/.bashrc, then the marks. */
export const BASHRC = `# Claudex terminal: marks the start and end of every command (OSC 133).
[ -r ~/.bashrc ] && builtin source ~/.bashrc
__claudex_prompt() {
  local status=$?
  builtin printf '${PROMPT_MARK}' "$status"
  return $status
}
__claudex_arm() { __claudex_armed=1; }
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0="\${PS0-}"$'\\e]133;C\\a'
  PROMPT_COMMAND="__claudex_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
else
  __claudex_armed=
  __claudex_debug() {
    [ -n "$__claudex_armed" ] || return
    case "$BASH_COMMAND" in __claudex_*) return ;; esac
    __claudex_armed=
    builtin printf '${COMMAND_MARK}'
  }
  [ -z "$(trap -p DEBUG)" ] && trap '__claudex_debug' DEBUG
  PROMPT_COMMAND="__claudex_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND};__claudex_arm"
fi
if [ -n "\${CLAUDEX_SI_TMP-}" ]; then
  command rm -f -- "$CLAUDEX_SI_TMP/bashrc"
  command rmdir -- "$CLAUDEX_SI_TMP" 2>/dev/null
fi
unset CLAUDEX_SI_TMP
`;

/** fish's --init-command, run after its own configuration. */
export const FISH_INIT =
  "function __claudex_preexec --on-event fish_preexec; printf '\\e]133;C\\a'; end; " +
  "function __claudex_postexec --on-event fish_postexec; printf '\\e]133;D;%s\\a' $status; end";

/** Files of the integration, by their place under its folder. */
const FILES: Record<string, string> = {
  "zsh/.zshenv": ZSHENV,
  "zsh/.zshrc": ZSHRC,
  "bash/bashrc": BASHRC,
};

/**
 * Writes the integration's files under `dir` (left as they are when they
 * already say the same) and answers the folder. The shell only reads them,
 * so a read-only sandbox still has its marks.
 */
export function writeShellIntegration(dir: string): string {
  for (const [name, content] of Object.entries(FILES)) {
    const file = path.join(dir, name);
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      /* not written yet */
    }
    if (current === content) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  }
  return dir;
}

/**
 * This computer's shell with the hooks, read from the files written under
 * `dir`; a shell without integration is left as it is.
 */
export function integrateLocalShell(
  shell: TerminalShell,
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): TerminalShell {
  const [program] = shell.command;
  switch (shellKind(program)) {
    case "zsh":
      return {
        ...shell,
        command: [program, "-i"],
        env: {
          ...shell.env,
          ZDOTDIR: path.join(dir, "zsh"),
          CLAUDEX_USER_ZDOTDIR: env.ZDOTDIR ?? "",
        },
      };
    case "bash":
      return {
        ...shell,
        command: [program, "--rcfile", path.join(dir, "bash", "bashrc"), "-i"],
      };
    case "fish":
      return {
        ...shell,
        command: [program, "-i", "--init-command", FISH_INIT],
      };
    case "cmd":
      // Command Prompt has no hook before a command; the prompt mark is
      // enough with the line entered at it (CommandMarks.input). $E is ESC.
      return {
        ...shell,
        env: { ...shell.env, PROMPT: `$E]133;A$E\\${env.PROMPT || "$P$G"}` },
      };
    default:
      return shell;
  }
}

/**
 * An SSH host's shell with the hooks. The files cannot be written there
 * ahead of time, so a small sh script writes them to a fresh temporary
 * folder from the environment and starts the shell on them (the rc files
 * remove the folder once read). Where the folder cannot be made (a
 * read-only sandbox) the shell starts as before, without marks.
 */
export function integrateRemoteShell(shell: TerminalShell): TerminalShell {
  const [program] = shell.command;
  const kind = shellKind(program);
  if (kind === "fish")
    return { ...shell, command: [program, "-i", "--init-command", FISH_INIT] };
  if (kind !== "zsh" && kind !== "bash") return shell;
  const make =
    'd=$(mktemp -d "${TMPDIR:-/tmp}/claudex-shell.XXXXXX" 2>/dev/null) || exec "$1" -i; ';
  const script =
    kind === "zsh"
      ? make +
        'printf "%s" "$CLAUDEX_SI_ZSHENV" > "$d/.zshenv" && printf "%s" "$CLAUDEX_SI_ZSHRC" > "$d/.zshrc" || exec "$1" -i; ' +
        "unset CLAUDEX_SI_ZSHENV CLAUDEX_SI_ZSHRC; " +
        'export CLAUDEX_USER_ZDOTDIR="${ZDOTDIR-}" ZDOTDIR="$d" CLAUDEX_SI_TMP="$d"; exec "$1" -i'
      : make +
        'printf "%s" "$CLAUDEX_SI_BASHRC" > "$d/bashrc" || exec "$1" -i; ' +
        "unset CLAUDEX_SI_BASHRC; " +
        'export CLAUDEX_SI_TMP="$d"; exec "$1" --rcfile "$d/bashrc" -i';
  return {
    ...shell,
    command: ["/bin/sh", "-c", script, "sh", program],
    env: {
      ...shell.env,
      ...(kind === "zsh"
        ? { CLAUDEX_SI_ZSHENV: ZSHENV, CLAUDEX_SI_ZSHRC: ZSHRC }
        : { CLAUDEX_SI_BASHRC: BASHRC }),
    },
  };
}

/** Longest stretch of an unfinished mark kept for the next piece of output. */
const CARRY_LIMIT = 64;

/**
 * Reads the prompt marks off a tab's output, in pieces as they arrive.
 * `busy` is undefined until the shell printed a mark (a shell without
 * integration never does), then whether a command is running: true from a
 * command mark (133;C), false from a prompt mark (133;A or 133;D).
 */
export class CommandMarks {
  busy: boolean | undefined;
  /** The shell marks commands itself (a shell that only marks its prompt does not). */
  private commandMarks = false;
  private carry = "";

  /** Output of the tab; answers whether `busy` changed. */
  feed(bytes: Uint8Array): boolean {
    const before = this.busy;
    // latin1 keeps every byte as one character, so a mark split between two
    // pieces or between multibyte text reads the same.
    const text = this.carry + Buffer.from(bytes).toString("latin1");
    this.carry = "";
    const marks = /\x1b\]133;([A-D])[^\x07\x1b]*(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null;
    let end = 0;
    while ((match = marks.exec(text))) {
      end = marks.lastIndex;
      const mark = match[1];
      if (mark === "C") {
        this.commandMarks = true;
        this.busy = true;
      } else if (mark === "A" || mark === "D") this.busy = false;
    }
    // An escape after the last whole mark may be the start of one.
    const start = text.lastIndexOf("\x1b");
    if (start >= end && text.length - start < CARRY_LIMIT)
      this.carry = text.slice(start);
    return this.busy !== before;
  }

  /**
   * Input typed into the tab; answers whether `busy` changed. For a shell
   * that marks only its prompt, a line entered at the prompt is a command
   * running until the next prompt.
   */
  input(bytes: Uint8Array): boolean {
    if (this.commandMarks || this.busy !== false) return false;
    if (!bytes.includes(13) && !bytes.includes(10)) return false;
    this.busy = true;
    return true;
  }
}
