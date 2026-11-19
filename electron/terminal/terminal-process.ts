import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type TerminalProcessExecutor = (argv: string[]) => Promise<void>;

const execFileAsync = promisify(execFile);
export const localTerminalProcess: TerminalProcessExecutor = async ([program, ...args]) => {
  await execFileAsync(program, args, { timeout: 5000 });
};

const linuxCleanup = `root="$1"
for entry in /proc/[0-9]*; do
  IFS= read -r stat 2>/dev/null < "$entry/stat" || continue
  set -- \${stat##*) }
  printf '%s %s %s\\n' "\${entry#/proc/}" "$2" "$4"
done | awk -v root="$root" '
{
  parents[$1] = $2
  if ($3 == root) owned[$1] = 1
}
END {
  do {
    changed = 0
    for (pid in parents)
      if (!owned[pid] && owned[parents[pid]]) {
        owned[pid] = 1
        changed = 1
      }
  } while (changed)
  for (pid in owned)
    if (owned[pid] && pid > 1 && pid != root) print pid
  if (owned[root]) print root
}' | while IFS= read -r pid; do
  kill -KILL "$pid" 2>/dev/null || :
done`;

const macCleanup = `root = Integer(ARGV.fetch(0), 10)
parents = {}
owned = {}
IO.popen(["/bin/ps", "-axo", "pid=,ppid="], &:read).each_line do |line|
  pid, parent = line.split.map(&:to_i)
  next unless pid && parent
  parents[pid] = parent
  begin
    owned[pid] = true if Process.getsid(pid) == root
  rescue SystemCallError
  end
end
loop do
  descendants = parents.keys.select { |pid| !owned[pid] && owned[parents[pid]] }
  break if descendants.empty?
  descendants.each { |pid| owned[pid] = true }
end
(owned.keys.reverse.reject { |pid| pid == root } + [root]).each do |pid|
  next unless pid > 1 && owned[pid]
  begin
    Process.kill("KILL", pid)
  rescue SystemCallError
  end
end`;

export function createTerminalProcess(
  platform: NodeJS.Platform,
  id: string,
  command: string[],
  execute: TerminalProcessExecutor,
) {
  if (platform !== "darwin" && platform !== "linux") return;
  const prefix = Buffer.from(`\u001b]777;claudex-pty:${id}:`);
  let pending: Buffer | undefined = Buffer.alloc(0);
  let pid: number | undefined;
  let cleaning: Promise<void> | undefined;
  return {
    // exec preserves the leader PID allocated to the PTY by Codex.
    command: [
      "/bin/sh", "-c",
      'printf "\\033]777;claudex-pty:%s:%s\\007" "$1" "$$"; shift; exec "$@"',
      "claudex-pty", id, ...command,
    ],
    read(bytes: Buffer): Buffer {
      if (!pending) return bytes;
      const buffered = Buffer.concat([pending, bytes]);
      const start = buffered.indexOf(prefix);
      if (start === -1) {
        const escape = buffered.lastIndexOf(prefix[0]);
        const suffix = escape < 0 ? undefined : buffered.subarray(escape);
        if (suffix?.equals(prefix.subarray(0, suffix.length))) {
          pending = suffix;
          return buffered.subarray(0, escape);
        }
        pending = Buffer.alloc(0);
        return buffered;
      }
      const tokenStart = start + prefix.length;
      const end = buffered.indexOf(7, tokenStart);
      if (end < 0 && buffered.length - tokenStart <= 10) {
        pending = buffered.subarray(start);
        return buffered.subarray(0, start);
      }
      pending = undefined;
      if (end >= 0) {
        const token = buffered.subarray(tokenStart, end).toString("ascii");
        const value = Number(token);
        if (/^[1-9][0-9]{0,9}$/.test(token) && value > 1 && value <= 2147483647) {
          pid = value;
          return Buffer.concat([buffered.subarray(0, start), buffered.subarray(end + 1)]);
        }
      }
      return buffered;
    },
    clean(): Promise<void> {
      if (pid === undefined) return Promise.resolve();
      return cleaning ??= execute(platform === "darwin"
        ? ["/usr/bin/ruby", "-e", macCleanup, String(pid)]
        : ["/bin/sh", "-c", linuxCleanup, "claudex-pty", String(pid)]
      ).catch(() => {});
    },
  };
}
