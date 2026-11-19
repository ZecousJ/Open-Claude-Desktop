import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type { EnvironmentRef } from "../../shared/types";
import type { ExecOptions } from "../ssh/connection";
import { collectOutput } from "../ssh/connection-support";
import {
  connectionRunner,
  RemoteUnavailableError,
  RemoteWorkspace,
} from "../ssh/remote-workspace";

function executable() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "wsl.exe")
    : "wsl.exe";
}

export interface WslDistro {
  name: string;
  version: number;
  isDefault: boolean;
}

export async function listWslDistros(): Promise<WslDistro[]> {
  if (process.platform !== "win32") return [];
  return new Promise((resolve) => {
    execFile(
      executable(),
      ["--list", "--verbose"],
      { encoding: "buffer", timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve([]);
        const output = stdout.includes(0)
          ? stdout.toString("utf16le")
          : stdout.toString("utf8");
        resolve(
          output.split(/\r?\n/).flatMap((line) => {
            const match = line.match(
              /^\s*(\*)?\s*(.+?)\s{2,}\S.*?\s{2,}([12])\s*$/,
            );
            return match
              ? [
                  {
                    name: match[2].trim(),
                    version: Number(match[3]),
                    isDefault: !!match[1],
                  },
                ]
              : [];
          }),
        );
      },
    );
  });
}

export class WslShell {
  constructor(readonly distro: string) {}

  spawn(argv: string[]) {
    return spawn(
      executable(),
      ["--distribution", this.distro, "--cd", "~", "--exec", ...argv],
      { stdio: "pipe", windowsHide: true },
    );
  }

  spawnScript(script: string) {
    const source = Buffer.from(script).toString("base64");
    return this.spawn([
      "/bin/sh",
      "-c",
      'eval "$(printf %s "$1" | base64 -d)"',
      "claudex",
      source,
    ]);
  }

  async exec(script: string, options: ExecOptions = {}) {
    const child =
      options.input === undefined
        ? this.spawn(["/bin/sh", "-s"])
        : this.spawnScript(script);
    const result = await collectOutput(child, {
      ...options,
      input: options.input ?? script + "\n",
    });
    if (result.code === null || result.code < 0 || result.code > 255)
      throw new RemoteUnavailableError(
        `Couldn't run a command in WSL distro ${this.distro}.`,
      );
    return { ...result, stderr: result.stderr.replaceAll("\0", "") };
  }
}

class WslWorkspace extends RemoteWorkspace {
  override readonly environment = {
    kind: "wsl",
    distro: this.hostId,
  } satisfies EnvironmentRef;

  constructor(distro: string) {
    const run = connectionRunner(new WslShell(distro));
    super(distro, distro, () => run);
  }
}

export function wslWorkspace(distro: string): RemoteWorkspace {
  return new WslWorkspace(distro);
}
