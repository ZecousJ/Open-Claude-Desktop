import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DevServers, type DevServersDeps } from "../browser/dev-servers";
import { shQuote } from "../ssh/remote-scripts";
import { wslFolderPath, wslFolderUnc } from "./paths";
import { WslShell } from "./wsl";

export function wslPreviewScript(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const variables = Object.entries(env).flatMap(([key, value]) =>
    value === undefined || (key === "PATH" && !value)
      ? []
      : [`${key}=${value}`],
  );
  return [
    `cd ${shQuote(cwd)} || exit 1`,
    `setsid env ${[...variables, command, ...args].map(shQuote).join(" ")} &`,
    "server=$!",
    "trap 'kill -KILL -- \"-$server\" 2>/dev/null || true' EXIT",
    'while kill -0 "$server" 2>/dev/null; do',
    "  IFS= read -r -t 0.2 signal",
    "  result=$?",
    '  if [ "$result" = 0 ]; then',
    '    case "$signal" in SIGTERM|SIGKILL) kill -s "$signal" -- "-$server" 2>/dev/null || true ;; esac',
    '  elif [ "$result" -le 128 ]; then kill -KILL -- "-$server" 2>/dev/null || true; break; fi',
    "done",
    'wait "$server"',
  ].join("\n");
}

export class WslDevServers extends DevServers {
  constructor(
    distro: string,
    deps: Pick<DevServersDeps, "conversation" | "unattended" | "allowed">,
  ) {
    const shell = new WslShell(distro);
    const children = new Map<number, ChildProcessWithoutNullStreams>();
    super({
      ...deps,
      conversation: (id) => {
        const conversation = deps.conversation(id);
        return conversation?.cwd
          ? { cwd: wslFolderUnc(distro, conversation.cwd) }
          : conversation;
      },
      platform: "linux",
      executionPath: (folder) => wslFolderPath(folder)?.cwd ?? folder,
      env: {},
      shellPath: async () => {
        const result = await shell.exec(
          '"${SHELL:-/bin/sh}" -ilc \'printf "\\n__CLAUDEX_PREVIEW_PATH__%s__CLAUDEX_PREVIEW_PATH__\\n" "$PATH"\'',
          { timeoutMs: 5000, maxOutput: 1024 * 1024 },
        );
        return result.stdout.match(
          /__CLAUDEX_PREVIEW_PATH__(.*?)__CLAUDEX_PREVIEW_PATH__/,
        )?.[1];
      },
      spawn: (command, args, options) => {
        const folder =
          typeof options.cwd === "string" && wslFolderPath(options.cwd);
        if (!folder) throw new Error("The WSL preview folder is unavailable.");
        const child = shell.spawn([
          "/bin/bash",
          "-c",
          wslPreviewScript(command, args, folder.cwd, options.env ?? {}),
        ]);
        const pid = child.pid;
        if (pid) {
          children.set(pid, child);
          child.once("close", () => children.delete(pid));
        }
        child.stdin.on("error", () => {});
        return child;
      },
      kill: (pid, signal) => {
        children.get(pid)?.stdin.write(`${signal}\n`);
      },
    });
  }

  override readConfig: DevServers["readConfig"] = (conversationId) => {
    const config = DevServers.prototype.readConfig.call(this, conversationId);
    const folder = config.folder && wslFolderPath(config.folder);
    if (!folder) return config;
    return {
      ...config,
      result: {
        ...config.result,
        configurations: config.result.configurations.map((entry) => ({
          ...entry,
          ...(entry.cwd?.startsWith("/")
            ? { cwd: wslFolderUnc(folder.distro, entry.cwd) }
            : {}),
        })),
      },
    };
  };
}
