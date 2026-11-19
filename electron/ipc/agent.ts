import { browserMcpPort } from "../browser/browser-tools-registration";
import type { AppContext, IpcHandle } from "../app/app-context";
import { WslLauncher } from "../wsl/wsl-launcher";
import { registerCodeLimitAutoResume } from "../engine/code-limit-auto-resume";
import { registerCodeEditorTools } from "../workspace/editor-tool";
import { registerCodeSessionHelpers } from "../engine/code-session-helpers";
import { registerCodeHelperWake } from "../engine/code-helper-wake";
import { registerCodeHelperCloud } from "../engine/code-helper-cloud";

/**
 * Agent runtime calls (package WP5a) beyond the workflow agent ones in
 * `workflow.ts`, such as the reply feedback dialog. Their bridge names are
 * declared in `shared/agent-api.ts`.
 *
 * R9-S3: binds the engine registry to the app here, so conversations on
 * SSH hosts get their own engines (electron/engine-registry.ts): the SSH
 * service, the administrator's runtime mirror, folder checks, events and
 * the account's lifecycle.
 */
export function registerAgentHandlers(_handle: IpcHandle, ctx: AppContext) {
  if (typeof ctx.engines?.bind !== "function") return;
  ctx.engines.bind({
    ssh: () => ctx.services.ssh,
    browserPort: () => browserMcpPort(ctx),
    get dataRoot() {
      return ctx.dataRoot;
    },
    mirror: () => {
      try {
        return ctx.policy().codexRuntimeMirror ?? null;
      } catch {
        return null;
      }
    },
    ...(process.platform === "win32"
      ? {
          wslLauncher: (distro: string, accountRoot: string) =>
            new WslLauncher({
              distro,
              accountRoot,
              dataRoot: ctx.dataRoot,
              mirror: () => ctx.policy().codexRuntimeMirror,
              browserPort: () => browserMcpPort(ctx),
            }),
        }
      : {}),
    allowedFolder: (folder, environment) =>
      ctx.allowedFolder(folder, environment),
    push: (event) => ctx.push(event),
    onEvent: (cb) => ctx.onEvent(cb),
    onAccountActivated: (cb) => ctx.onAccountActivated(() => cb()),
    onAccountDeactivating: (cb) => ctx.onAccountDeactivating(cb),
    ...(ctx.spaceSandbox
      ? {
          space: (spaceId: string) => ctx.spaceSandbox!(spaceId),
          spaceStopped: (spaceId: string) => ctx.spaceStopped?.(spaceId),
        }
      : {}),
  });
  if (process.versions.electron) {
    registerCodeLimitAutoResume(ctx);
    registerCodeEditorTools(ctx);
    registerCodeSessionHelpers(ctx);
    registerCodeHelperWake(ctx);
    registerCodeHelperCloud(ctx);
  }
}
