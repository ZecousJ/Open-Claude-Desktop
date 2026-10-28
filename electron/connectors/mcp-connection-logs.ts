import type { McpLogSnapshot } from "../../shared/settings-mcp-api";

const sensitiveKey =
  /token|secret|password|auth|credential|api.?key|access.?key|private.?key|header|cookie/i;

/** Collect configured secrets before writing anything into the retained buffer. */
export function mcpSecrets(config: unknown): string[] {
  const secrets = new Set<string>();
  const walk = (value: unknown, sensitive = false) => {
    if (typeof value === "string" && sensitive && value) secrets.add(value);
    else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const previous = value[index - 1];
        walk(
          entry,
          sensitive ||
            (typeof previous === "string" && sensitiveKey.test(previous)),
        );
      });
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value))
        walk(entry, sensitive || key === "env" || sensitiveKey.test(key));
    }
  };
  walk(config);
  return [...secrets].sort((a, b) => b.length - a.length);
}

export function redactMcpText(raw: string, secrets: readonly string[] = []) {
  let text = raw;
  const variants = new Set(
    secrets
      .flatMap((value) => [
        value,
        JSON.stringify(value).slice(1, -1),
        ...value.split(/\r?\n/),
      ])
      .filter(Boolean),
  );
  for (const secret of [...variants].sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[redacted]");
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[redacted]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(
      /(\b["']?(?:[\w-]*(?:token|secret|password|authorization|credential|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Per-engine and therefore per-owner. Memory only: 128 servers × 64 KiB maximum. */
export class McpConnectionLogs {
  private logs = new Map<
    string,
    { lines: string[]; bytes: number; truncated: boolean }
  >();
  constructor(private configured: () => Record<string, unknown>) {}
  record(name: unknown, status: unknown, error?: unknown, now = new Date()) {
    const configs = this.configured();
    for (const key of this.logs.keys())
      if (!Object.hasOwn(configs, key)) this.logs.delete(key);
    if (
      typeof name !== "string" ||
      !Object.hasOwn(configs, name) ||
      !["starting", "ready", "failed", "cancelled"].includes(String(status))
    )
      return;
    if (!this.logs.has(name) && this.logs.size >= 128)
      this.logs.delete(this.logs.keys().next().value!);
    const log = this.logs.get(name) ?? {
      lines: [],
      bytes: 0,
      truncated: false,
    };
    const safe = redactMcpText(
      `${String(status)}${typeof error === "string" ? `: ${error}` : ""}`,
      mcpSecrets(configs),
    );
    // Reserve space for the timestamp and a possible UTF-8 replacement character.
    const payload = Buffer.from(safe).subarray(0, 4000).toString("utf8");
    const line = `${now.toISOString()} ${payload}`;
    log.lines.push(line);
    log.bytes += Buffer.byteLength(line);
    while (log.lines.length > 200 || log.bytes > 64 * 1024) {
      log.bytes -= Buffer.byteLength(log.lines.shift()!);
      log.truncated = true;
    }
    this.logs.set(name, log);
  }
  read(name: string): McpLogSnapshot {
    if (!Object.hasOwn(this.configured(), name))
      throw Error("This MCP server no longer exists.");
    const log = this.logs.get(name);
    return {
      name,
      kind: "connection-events",
      lines: [...(log?.lines ?? [])],
      truncated: log?.truncated ?? false,
    };
  }
}
