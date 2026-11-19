import path from "node:path";

export function wslFolderPath(folder: string) {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\/]+)(?:\\(.*))?$/i.exec(
    folder,
  );
  if (!match) return undefined;
  return {
    distro: match[1],
    cwd: path.posix.normalize(`/${(match[2] ?? "").replaceAll("\\", "/")}`),
  };
}

export function wslFolderUnc(distro: string, cwd: string) {
  return path.win32.join(`\\\\wsl.localhost\\${distro}\\`, ...path.posix.resolve(cwd).split("/"));
}
