import type { AppContext, IpcHandle } from "../app/app-context";

/**
 * Agent runtime calls beyond the workflow agent ones in `workflow.ts`, such as
 * the reply feedback dialog. Their bridge names are declared in
 * `shared/agent-api.ts`.
 *
 * R9-S3: binds the engine registry to the app here, so conversations on SSH
 * hosts get their own engines: the SSH service, the administrator's runtime
 * mirror, folder checks, events and the account's lifecycle.
 */
export function registerAgentHandlers(_handle: IpcHandle, ctx: AppContext) {
  if (typeof ctx.engines?.bind !== "function") return;
  ctx.engines.bind({
    ssh: () => ctx.services.ssh,
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
}
