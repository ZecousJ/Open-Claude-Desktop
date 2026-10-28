/**
 * Whether the SSH environment UI shows (R9). Two things must hold:
 *
 * - the main process can reach hosts (`sshListHosts().sshAvailable`: an
 *   OpenSSH program is installed and the administrator did not turn SSH
 *   off; R9-S1 and the client policy);
 * - a Code conversation can run on a host. That needs the remote engine
 *   (R9-S3) and the composer's send to carry the chosen environment
 *   (`currentCodeEnvironment()` from codeEnvironment.ts). Until both are in,
 *   choosing a host could not start anything, so nothing SSH shows (no fake
 *   features). Both are in: R9-S3/R9-S4 run sessions on a host and the
 *   composer's send carries the environment (src/app/composer-send.ts).
 *
 * The preview (scripts/preview/fixtures/ssh.ts) turns the second check on
 * to draw the states against the references.
 */
const remoteCodeSessions: boolean = true;

let preview = false;

/** For the fidelity preview only. */
export function previewRemoteSessions() {
  preview = true;
}

export function sshUiReady(sshAvailable: boolean) {
  return sshAvailable && (remoteCodeSessions || preview);
}
