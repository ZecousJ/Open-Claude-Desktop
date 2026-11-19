import { readFile } from "node:fs/promises";
import path from "node:path";
import { version as appVersion } from "../../package.json";
import type { EnvironmentRef } from "../../shared/types";
import type { EngineLauncher, EngineLaunchInput } from "../engine/engine-types";
import { bundledCodexDirectory } from "../engine/runtime";
import { connectionRunner } from "../ssh/remote-workspace";
import {
  RemoteRuntime,
  clientIdFor,
  type RemoteRuntimeLayout,
} from "../ssh/remote-runtime";
import {
  PROBE_SCRIPT,
  parseProbe,
  shQuote,
  workspaceTrustScript,
} from "../ssh/remote-scripts";
import { RUNTIME_CACHE_DIR, RuntimeCache } from "../ssh/runtime-cache";
import {
  engineId,
  gatewayAddress,
  wrapperScript,
} from "../ssh/ssh-launcher-support";
import { deviceId } from "../sub2api/provision";
import { parseRemoteTrust } from "../workspace/workspace-trust";
import { startWslGateway } from "./gateway-relay";
import { listWslDistros, WslShell } from "./wsl";

export interface WslLauncherOptions {
  distro: string;
  dataRoot: string;
  accountRoot: string;
  mirror?: () => string | null | undefined;
  browserPort?: () => number | undefined;
}

export class WslLauncher implements EngineLauncher {
  readonly environment: EnvironmentRef;
  readonly platform = "linux";
  readonly label: string;
  private readonly shell: WslShell;
  private relay?: Awaited<ReturnType<typeof startWslGateway>>;
  private runtime?: RemoteRuntime;
  private browserRelay?: {
    hostPort: number;
    relay: Awaited<ReturnType<typeof startWslGateway>>;
  };
  private activeEngine?: string;

  constructor(private readonly options: WslLauncherOptions) {
    this.environment = { kind: "wsl", distro: options.distro };
    this.label = options.distro;
    this.shell = new WslShell(options.distro);
  }

  waiting() {
    return false;
  }

  async defaultCwd() {
    const result = await this.shell.exec('printf "%s\\n" "$HOME"');
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async workspaceTrust(folder: string) {
    const result = await this.shell.exec(workspaceTrustScript(folder), {
      timeoutMs: 20_000,
      maxOutput: 65_536,
    });
    const trust =
      result.code === 0 ? parseRemoteTrust(result.stdout) : undefined;
    if (!trust)
      throw new Error("Couldn’t check whether this WSL workspace is trusted.");
    return trust;
  }

  terminalProcessExecutor() {
    const run = connectionRunner(this.shell);
    return async (argv: string[]) => {
      const result = await run({ argv, timeoutMs: 5000, maxOutput: 4096 });
      if (result.code !== 0)
        throw new Error("WSL terminal process cleanup failed.");
    };
  }

  async launch(input: EngineLaunchInput) {
    this.stopRelays();
    const installed = await listWslDistros();
    if (
      !installed.some(
        ({ name, version }) =>
          version === 2 && name.toLowerCase() === this.label.toLowerCase(),
      )
    )
      throw new Error(
        `Choose an installed WSL 2 distribution for ${this.label}.`,
      );
    const result = await this.shell.exec(PROBE_SCRIPT);
    const probe = result.code === 0 ? parseProbe(result.stdout) : undefined;
    if (probe?.os !== "Linux")
      throw new Error(`Couldn't start WSL distro ${this.label}.`);
    const runtime = (this.runtime ??= new RemoteRuntime({
      shell: this.shell,
      probe,
      label: this.label,
      clientId: clientIdFor(deviceId(this.options.dataRoot)),
      remoteRoot: `~/.claudex-wsl/${path.basename(this.options.accountRoot)}`,
      cache: new RuntimeCache({
        dir: path.join(this.options.dataRoot, RUNTIME_CACHE_DIR),
      }),
      mirror: this.options.mirror?.() ?? null,
    }));
    const layout = await runtime.ensure();
    const relayPath = await this.installRelay(layout);
    const gateway = gatewayAddress(input.gatewayUrl);
    const relay = (this.relay = await startWslGateway(
      this.shell.spawn([relayPath]),
      gateway.port,
    ));
    const browserPort = this.options.browserPort?.();
    if (browserPort) {
      this.browserRelay = {
        hostPort: browserPort,
        relay: await startWslGateway(
          this.shell.spawn([relayPath]),
          browserPort,
        ),
      };
    }
    const id = (this.activeEngine = engineId());
    const script = [
      'export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"',
      'export no_proxy="127.0.0.1,localhost${no_proxy:+,$no_proxy}"',
      wrapperScript({
        layout,
        engineId: id,
        args: input.args,
        basePath: gateway.path,
      }),
    ].join("\n");
    const config = Buffer.from(input.configToml).toString("base64");
    return {
      spawn: () => {
        const child = this.shell.spawnScript(script);
        void relay.closed.then(() => child.stdin.end());
        return child;
      },
      preamble: `${relay.port}\n${input.gatewayToken}\n${config}\n`,
    };
  }

  started() {
    if (this.activeEngine)
      void this.runtime?.cleanup([this.activeEngine]).catch(() => {});
  }

  exited() {
    this.stopRelays();
  }

  failed() {
    this.stopRelays();
  }

  async dispose() {
    this.stopRelays();
    this.relay = undefined;
  }

  browserUrl(input: string) {
    const url = new URL(input);
    if (this.browserRelay?.hostPort !== Number(url.port)) return;
    url.hostname = "127.0.0.1";
    url.port = String(this.browserRelay.relay.port);
    return url.href;
  }

  private stopRelays() {
    this.browserRelay?.relay.stop();
    this.browserRelay = undefined;
    this.relay?.stop();
  }

  private async installRelay(layout: RemoteRuntimeLayout) {
    const filename = `wsl-gateway-linux-${layout.triple.startsWith("x86_64-") ? "amd64" : "arm64"}`;
    const target = `${layout.dir}/bin/wsl-gateway-${appVersion}`;
    const present = await this.shell.exec(`test -x ${shQuote(target)}`);
    if (present.code === 0) return target;
    const root =
      process.resourcesPath && !process.defaultApp
        ? bundledCodexDirectory(process.resourcesPath)
        : path.resolve("build", "runtime");
    const bytes = await readFile(path.join(root, filename)).catch(() => {
      throw new Error("The bundled WSL gateway is missing.");
    });
    const result = await this.shell.exec(
      [
        "umask 077",
        `target=${shQuote(target)}`,
        'temporary=$(mktemp "$target.XXXXXX") || exit 1',
        "trap 'rm -f \"$temporary\"' EXIT",
        'cat > "$temporary" && chmod 700 "$temporary" && mv -f "$temporary" "$target"',
      ].join("\n"),
      { input: bytes },
    );
    if (result.code !== 0)
      throw new Error(`Couldn't install the WSL gateway in ${this.label}.`);
    return target;
  }
}
