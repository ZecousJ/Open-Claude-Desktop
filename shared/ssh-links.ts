export interface SshLinkTarget {
  sshHost: string;
  sshPort?: number;
  folder?: string;
  prompt?: string;
}

export const sshLinkErrors = {
  invalid_host: "Couldn’t open link. Use a link with a valid SSH host.",
  invalid_port:
    "Couldn’t open link. Use a link with an SSH port between 1 and 65535.",
  invalid_folder:
    "Couldn’t open link. Use a link with a valid remote folder path.",
  ambiguous:
    "Couldn’t open link. Use a link with a local folder or an SSH host, not both.",
  truncated: "Couldn’t open link. Use a shorter link.",
} as const;

/** Query validation. */
export function parseSshLink(
  query: URLSearchParams,
):
  | { kind: "ssh"; target: SshLinkTarget }
  | { kind: "ssh-error"; error: keyof typeof sshLinkErrors }
  | undefined {
  const error = (error: keyof typeof sshLinkErrors) => ({
    kind: "ssh-error" as const,
    error,
  });
  const refused = query.get("ssh_refused");
  if (refused && Object.hasOwn(sshLinkErrors, refused))
    return error(refused as keyof typeof sshLinkErrors);
  if (!["ssh_host", "ssh_port", "ssh_folder"].some((key) => query.has(key)))
    return undefined;
  if (query.has("folder")) return error("ambiguous");
  const hosts = query.getAll("ssh_host");
  const host = hosts[0] ?? "";
  const at = host.indexOf("@");
  const user = at === -1 ? undefined : host.slice(0, at);
  const address = at === -1 ? host : host.slice(at + 1);
  if (
    hosts.length !== 1 ||
    address.length > 253 ||
    !/^[a-zA-Z0-9.:_][a-zA-Z0-9.:_-]*$/.test(address) ||
    (user !== undefined &&
      (user.length > 64 ||
        !/^[a-zA-Z0-9._][a-zA-Z0-9._\\-]*(?<!\\)$/.test(user)))
  )
    return error("invalid_host");
  try {
    if (String(JSON.parse(host)) !== host) return error("invalid_host");
  } catch {}
  const ports = query.getAll("ssh_port");
  const port = ports[0];
  if (
    ports.length > 1 ||
    (port !== undefined &&
      (!/^[1-9]\d{0,4}$/.test(port) ||
        Number(port) > 65535 ||
        /^[^:]+:\d+$/.test(address)))
  )
    return error("invalid_port");
  const folders = query.getAll("ssh_folder");
  const folder = folders[0];
  if (
    folders.length > 1 ||
    (folder !== undefined &&
      (!/^(?:\/(?!\/)|~(?:\/|$))/.test(folder) ||
        folder.length > 1024 ||
        folder !== folder.trim() ||
        /[\\'\u2018-\u201B\x00-\x1f\x7f\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u.test(
          folder,
        ) ||
        !/^[\p{L}\p{N}\p{M}\p{P} +<=>^`|~$]+$/u.test(folder) ||
        / {3,}/.test(folder.replace(/\p{M}+/gu, "")) ||
        (folder.match(/ /g)?.length ?? 0) > 8 ||
        /\p{M}{4,}/u.test(folder) ||
        /^\/(?:\.vol|\.file)(?:\/|$)/i.test(folder) ||
        folder.split("/").includes("..")))
  )
    return error("invalid_folder");
  return {
    kind: "ssh",
    target: {
      sshHost: host,
      ...(port ? { sshPort: Number(port) } : {}),
      ...(folder ? { folder } : {}),
    },
  };
}

export function sshLinkIdentity(host: string, port = 22) {
  const at = host.indexOf("@");
  return `${at === -1 ? "" : host.slice(0, at)}@${host
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "")}:${port}`;
}
