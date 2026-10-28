import fs from "node:fs";
import path from "node:path";
import {
  mcpStdioFileBytes,
  mcpStdioFiles,
  type McpStdioDescriptor,
} from "../shared/mcp-stdio-logs";

const safeFile = (directory: string, name: string) => {
  if (
    fs.realpathSync(directory) !== directory ||
    fs.lstatSync(directory).isSymbolicLink() ||
    (fs.statSync(directory).mode & 0o077) !== 0
  )
    throw Error("Private MCP log directory unavailable.");
  const file = path.join(directory, name);
  try {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw Error("Private MCP log file unavailable.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
};
export function liveMcpLease(
  descriptor: Pick<
    McpStdioDescriptor,
    "directory" | "owner" | "version" | "token"
  >,
) {
  try {
    const file = safeFile(descriptor.directory, "lease.json");
    if (fs.statSync(file).size > 2048) return false;
    const lease = JSON.parse(fs.readFileSync(file, "utf8"));
    return (
      lease.active === true &&
      lease.owner === descriptor.owner &&
      lease.version === descriptor.version &&
      lease.token === descriptor.token
    );
  } catch {
    return false;
  }
}
export function captureState(
  descriptor: McpStdioDescriptor,
  state: "capturing" | "stopped" | "failed",
) {
  if (!liveMcpLease(descriptor)) return;
  try {
    fs.writeFileSync(safeFile(descriptor.directory, "state"), state, {
      mode: 0o600,
    });
  } catch {
    /* Logging failure never exposes raw stderr. */
  }
}
/** Accepts already scrubbed records only. The wrapper is the sole raw-stderr reader. */
export class McpPrivateLogStore {
  constructor(
    private descriptor: McpStdioDescriptor,
    private limits = { bytes: mcpStdioFileBytes, files: mcpStdioFiles },
  ) {}
  appendRedacted(line: string) {
    if (!liveMcpLease(this.descriptor)) return false;
    const directory = this.descriptor.directory;
    let lock: number | undefined;
    const lockFile = path.join(directory, "write.lock");
    try {
      // Multiple app-server instances may start the same server. Serialise file
      // rotation; contention drops diagnostics, never blocks the MCP protocol.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          lock = fs.openSync(safeFile(directory, "write.lock"), "wx", 0o600);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          try {
            const pid = Number(fs.readFileSync(lockFile, "utf8"));
            if (!Number.isSafeInteger(pid) || pid <= 0) break;
            try {
              process.kill(pid, 0);
              break;
            } catch (failure) {
              if ((failure as NodeJS.ErrnoException).code !== "ESRCH") break;
            }
            fs.unlinkSync(lockFile);
          } catch {
            break;
          }
        }
      }
      if (lock === undefined) {
        this.dropped();
        return false;
      }
      fs.writeFileSync(lock, String(process.pid));
      if (!liveMcpLease(this.descriptor)) return false;
      const data = Buffer.from(`${new Date().toISOString()} ${line}\n`);
      if (data.length > this.limits.bytes) {
        this.dropped();
        return false;
      }
      const file = safeFile(directory, "stderr.log");
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size + data.length > this.limits.bytes) {
        for (let index = this.limits.files - 1; index >= 1; index--) {
          const target = safeFile(directory, `stderr.log.${index}`);
          const source = safeFile(
            directory,
            index === 1 ? "stderr.log" : `stderr.log.${index - 1}`,
          );
          if (fs.existsSync(target)) fs.unlinkSync(target);
          if (fs.existsSync(source)) fs.renameSync(source, target);
        }
        this.dropped();
      }
      fs.appendFileSync(file, data, { mode: 0o600 });
      return true;
    } catch {
      this.dropped();
      return false;
    } finally {
      if (lock !== undefined) {
        fs.closeSync(lock);
        try {
          fs.unlinkSync(lockFile);
        } catch {}
      }
    }
  }
  dropped() {
    try {
      fs.writeFileSync(safeFile(this.descriptor.directory, "truncated"), "1", {
        mode: 0o600,
      });
    } catch {}
  }
}
export function readPrivateMcpTail(directory: string) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let partial = false;
  let truncated = fs.existsSync(path.join(directory, "truncated"));
  for (let index = 0; index < mcpStdioFiles && bytes < 64 * 1024; index++) {
    const file = safeFile(
      directory,
      index ? `stderr.log.${index}` : "stderr.log",
    );
    if (!fs.existsSync(file)) continue;
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 64 * 1024 - bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      chunks.unshift(buffer);
      bytes += length;
      if (length < size) {
        truncated = true;
        partial = true;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  let lines = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  if (partial && lines.length) lines.shift();
  if (lines.length > 200) {
    lines = lines.slice(-200);
    truncated = true;
  }
  return { lines, truncated };
}
