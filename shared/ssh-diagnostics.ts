export const sshDiagnosticMessages = {
  "ssh-too-old":
    "This computer’s ssh is older than OpenSSH 7.6, which Claudex needs to reach {host}. Update it, then retry.",
  "key-permissions":
    "Your key file for {host} can be read by other accounts, so ssh won’t use it. Run chmod 600 on it, then retry.",
  "key-putty":
    "The key file for {host} is a PuTTY .ppk that couldn’t be used. Export it as an OpenSSH key, then retry.",
  "key-passphrase":
    "{host} needs your key’s passphrase before your message can go. Retry and enter it.",
  "too-many-keys":
    "{host} closed the sign-in after too many keys. Set SSH key in this host’s settings, then retry.",
  "key-algorithm":
    "Your SSH key’s signature type can’t be used with {host}. Use a key type both sides allow (usually ed25519), then retry.",
  "key-missing":
    "The SSH key file set for {host} wasn’t found on this computer. Fix the path under SSH key, then retry.",
  "key-invalid":
    "Your key file for {host} couldn’t be parsed. Replace it with a fresh copy of the key, then retry.",
  "host-keys-not-kept":
    "Your SSH configuration sets UserKnownHostsFile to /dev/null or none for {host}, so a key you confirm can’t be saved. Set it to ~/.ssh/known_hosts or, to accept any key at every connection, use /dev/null with StrictHostKeyChecking accept-new. Then retry.",
  "session-limit":
    "{host} allows too few SSH sessions per connection. Ask its administrator to raise MaxSessions in sshd_config (10 is the default), then retry.",
  "remote-disk-full":
    "{host} is out of disk space. Free some space there (home directory or /tmp), then retry.",
  "remote-read-only":
    "{host}’s disk is read-only. Fix the disk there, then retry.",
  "ssh-config-invalid":
    "Your ssh stops at an error in your SSH configuration, so {host} can’t be reached. Fix it, then retry.",
  "ssh-managed-unusable":
    "The ssh program your organization configured can’t be used on this computer, so {host} can’t be reached. Ask your IT administrator, then retry.",
  "agent-refused":
    "{host} didn’t accept your SSH key. Unlock your agent, then retry.",
  "key-sign-failed":
    "{host} accepted your SSH key, but this computer couldn’t sign with it. Retry to enter the key’s passphrase.",
  "key-public-half":
    "{host} needs your private key: a .pub is set and your agent didn’t supply the key. To use your agent, start or unlock it and load your key. To sign in without it, set SSH key in this host’s settings to your private key file. Then retry.",
  "key-not-private":
    "The SSH key set for {host} isn’t a private key file. Choose your private key file, then retry.",
  "key-read-blocked":
    "macOS blocked ssh from reading your key file for {host}. Allow Claudex access under System Settings › Privacy & Security › Files and Folders (or move the key into ~/.ssh), then retry.",
  "key-protected-folder":
    "Your ssh can’t read the key for {host} where it’s kept — move it into ~/.ssh and update the key path, then retry.",
  "key-rsa-rejected":
    "{host} doesn’t accept RSA keys. Use a key of a type it accepts (usually ed25519), then retry.",
  "handshake-incompatible":
    "{host}’s SSH server isn’t compatible with this client.",
  "proxy-failed":
    "{host}’s proxy command can’t get through. Act on what it reported, then retry.",
  "proxy-browser-sign-in":
    "{host}’s proxy command needs you to sign in through your browser. Connect once with ssh in a terminal to sign in, then retry.",
  "teleport-sign-in":
    "Teleport needs you to sign in again to reach {host}. Run tsh login in a terminal, then retry.",
  "remote-no-input":
    "{host} doesn’t pass input to commands run over SSH. Ask its administrator to let them receive input, then retry.",
} as const;

export type SshDiagnosticCode = keyof typeof sshDiagnosticMessages;

export function sshDiagnosticMessage(code: string): string | undefined {
  return Object.hasOwn(sshDiagnosticMessages, code)
    ? sshDiagnosticMessages[code as SshDiagnosticCode]
    : undefined;
}

export function classifySshDiagnostic(
  stderr: string,
): SshDiagnosticCode | undefined {
  if (
    /UNPROTECTED PRIVATE KEY FILE|bad permissions|Bad owner or permissions|Permissions .* too open/i.test(
      stderr,
    )
  )
    return "key-permissions";
  if (
    /PuTTY|\.ppk.*(?:invalid|unsupported)|(?:invalid|unsupported).*\.ppk/i.test(
      stderr,
    )
  )
    return "key-putty";
  if (
    /agent refused operation|agent is locked|agent contains no identities.*locked/i.test(
      stderr,
    )
  )
    return "agent-refused";
  if (/Too many authentication failures/i.test(stderr)) return "too-many-keys";
  if (
    /incorrect passphrase|bad passphrase|passphrase.*(?:required|needed)/i.test(
      stderr,
    )
  )
    return "key-passphrase";
  if (
    /Load key .*\.pub["']?:.*(?:invalid format|error in libcrypto)/i.test(
      stderr,
    )
  )
    return "key-public-half";
  if (/not a private key/i.test(stderr)) return "key-not-private";
  if (/Load key .*Operation not permitted/i.test(stderr))
    return "key-read-blocked";
  if (/Load key .*Permission denied/i.test(stderr))
    return "key-protected-folder";
  if (/sign_and_send_pubkey: signing failed/i.test(stderr))
    return "key-sign-failed";
  if (
    /ssh-rsa.*not in (?:PubkeyAcceptedAlgorithms|PubkeyAcceptedKeyTypes)/i.test(
      stderr,
    )
  )
    return "key-rsa-rejected";
  if (
    /no mutual signature|no matching signature|signature algorithm.*not (?:allowed|supported)/i.test(
      stderr,
    )
  )
    return "key-algorithm";
  if (
    /no matching (?:host key|key exchange|cipher|MAC)|protocol major versions differ/i.test(
      stderr,
    )
  )
    return "handshake-incompatible";
  if (
    /(?:identity file|Identity file|Load key).*No such file|no such identity/i.test(
      stderr,
    )
  )
    return "key-missing";
  if (/Load key .*invalid format|error in libcrypto/i.test(stderr))
    return "key-invalid";
  if (/Session open refused by peer|no more sessions/i.test(stderr))
    return "session-limit";
  if (
    /No space left on device|Disk quota exceeded|\bENOSPC\b|\bEDQUOT\b/i.test(
      stderr,
    )
  )
    return "remote-disk-full";
  if (/Read-only file system|\bEROFS\b/i.test(stderr))
    return "remote-read-only";
  if (
    /Bad configuration option|Bad SSH2? .*spec|terminating, \d+ bad configuration|Missing argument|unsupported option/i.test(
      stderr,
    )
  )
    return "ssh-config-invalid";
  if (
    /UserKnownHostsFile.*(?:\/dev\/null|none)|keeps no known_hosts/i.test(
      stderr,
    )
  )
    return "host-keys-not-kept";
  if (/EXEC_NO_INPUT/i.test(stderr)) return "remote-no-input";
  if (
    /tsh login|teleport.*(?:expired|login required|not logged in)/i.test(stderr)
  )
    return "teleport-sign-in";
  if (
    /https?:\/\/.*(?:login|authorize|authenticate)|(?:open|visit).*browser.*(?:sign in|log in|authenticate)/i.test(
      stderr,
    )
  )
    return "proxy-browser-sign-in";
  if (
    /proxy command.*(?:failed|exited|error)|stdio forwarding failed|kex_exchange_identification:.*proxy/i.test(
      stderr,
    )
  )
    return "proxy-failed";
  return undefined;
}
