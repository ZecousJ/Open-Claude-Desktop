/**
 * Switching the Code home between this computer and an SSH host, and
 * choosing a folder on a host. `setCwd` is the app's working-folder setter:
 * it holds the remote path while the environment is that host.
 */
import type { SshHost } from "../../shared/ssh-api";
import { codeEnvironmentState, setCodeEnvironment } from "./codeEnvironment";
import { isBusy, localEnvironment, sshHostId } from "./model";
import { connectSshHost, sshState } from "./useSshHosts";

type SetCwd = (cwd?: string) => void;

/** Back to this computer; a remote folder is no working folder here. */
export function selectLocal(setCwd: SetCwd) {
  if (!sshHostId(codeEnvironmentState().environment)) return;
  setCodeEnvironment({ environment: localEnvironment });
  setCwd(undefined);
}

/** Registers a folder on the host with the main process, then works in it. */
export async function chooseRemoteFolder(
  hostId: string,
  path: string,
  setCwd: SetCwd,
) {
  await window.desktop.sshChooseFolder(hostId, path);
  setCodeEnvironment({
    environment: { kind: "ssh", hostId },
    folder: path,
  });
  setCwd(path);
}

/**
 * Makes the host the Code environment and connects to it (a password or
 * host key question shows as a dialog). The host's default folder becomes
 * the working folder once connected; otherwise the folder is chosen next.
 */
export async function selectHost(
  host: SshHost,
  setCwd: SetCwd,
  onError: (error: unknown) => void,
) {
  const previous = codeEnvironmentState();
  if (sshHostId(previous.environment) !== host.id) {
    setCodeEnvironment({ environment: { kind: "ssh", hostId: host.id } });
    setCwd(undefined);
  }
  const status = sshState().statuses[host.id];
  const ready =
    status?.state === "ready" ? status : isBusy(status) ? undefined : null;
  const result = ready === null ? await connectSshHost(host.id) : ready;
  if (result?.state !== "ready" || !host.defaultFolder) return;
  // Still this host, and no folder chosen meanwhile.
  const now = codeEnvironmentState();
  if (sshHostId(now.environment) !== host.id || now.folder) return;
  try {
    await chooseRemoteFolder(host.id, host.defaultFolder, setCwd);
  } catch (error) {
    onError(error);
  }
}
