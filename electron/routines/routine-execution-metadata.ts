import type { AppContext } from "../app/app-context";
import type {
  Routine,
  RoutineBackend,
  RoutineListMetadata,
} from "../../shared/routines";
import { deviceLinkId, deviceName } from "../remote-control/device-identity";

/** Facts from the scheduler's owner, never the renderer's hostname or a cloud VM. */
export function routineExecutionMetadata(
  ctx: AppContext,
  task: Routine,
  backend: RoutineBackend,
): Pick<RoutineListMetadata, "source" | "host" | "device" | "provenance"> {
  const source = task.mode === "code" ? "code" : "chat";
  if (backend === "remote")
    return { source, host: "cloud", provenance: { backend } };
  if (task.environment?.kind === "ssh") {
    const hostId = task.environment.hostId;
    const ssh = ctx.services?.ssh;
    const host = ssh?.hosts.get(hostId);
    const connection = ssh?.existing(hostId);
    return {
      source,
      host: "ssh",
      device: {
        id: hostId,
        name: host?.label,
        // An absent connection has never been checked; do not start it to render a card.
        connectivity:
          connection?.status.state === "ready" ? "connected" : "unknown",
      },
      provenance: { backend },
    };
  }
  if (!task.environment || task.environment.kind === "local") {
    // AppContext.dataRoot is app.getPath('userData'), shared with the existing
    // device link. A runner's context reaches only the remote branch above.
    const id = ctx.dataRoot ? deviceLinkId(ctx.dataRoot) : undefined;
    return {
      source,
      host: "this-computer",
      device: id
        ? { id, name: deviceName(), connectivity: "connected" }
        : undefined,
      provenance: { backend, deviceId: id },
    };
  }
  return { source, provenance: { backend } };
}

/** Successful retrieval and the named backend define provenance; a failed
 * cached read cannot promise that its previously connected computer is awake. */
export function routineWithBackend(
  task: Routine,
  backend: RoutineBackend,
  stale = false,
): Routine {
  const metadata = task.listMetadata;
  return {
    ...task,
    executionLocation: backend,
    ...(metadata
      ? {
          listMetadata: {
            ...metadata,
            host: backend === "remote" ? "cloud" : metadata.host,
            device:
              backend === "remote"
                ? undefined
                : metadata.device && {
                    ...metadata.device,
                    connectivity: stale
                      ? "unknown"
                      : metadata.device.connectivity,
                  },
            provenance: {
              backend,
              deviceId:
                backend === "remote"
                  ? undefined
                  : metadata.provenance?.deviceId,
            },
          },
        }
      : {}),
  };
}
