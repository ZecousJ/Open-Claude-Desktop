#!/usr/bin/env node
/**
 * A stand-in for OpenSSH in the R9-S3 tests: "the host" is this computer,
 * with HOME set to FAKE_SSH_HOME. It behaves like ssh where the SSH
 * engine depends on it:
 *
 *  - `-M` keeps a master: the control path holds its pid until stdin ends;
 *  - `-O check|exit` and `-O forward|cancel -R 127.0.0.1:0:127.0.0.1:P`
 *    against the master; `forward` starts a loopback proxy to P and prints
 *    its port on stdout (like OpenSSH's mux client); `cancel`, like
 *    OpenSSH's mux, finds the forward by the spec it was opened with
 *    (listen port 0 and P) and fails with "port not found" for the
 *    allocated port (checked against real OpenSSH in tests/ssh/e2e.test.ts);
 *  - a command riding on the master (ControlPath set, not "none") fails
 *    with 255 when the master is gone;
 *  - a session with `-R 127.0.0.1:0:127.0.0.1:P` opens the proxy itself and,
 *    when LogLevel (first value wins, as in ssh) is INFO or more, prints
 *    "Allocated port N for remote forward to 127.0.0.1:P" on stderr;
 *  - the command after the destination runs with `sh -c`, its stdio
 *    passed through.
 *
 * FAKE_SSH_LOG, when set, gets one JSON line of arguments per run.
 */
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

/** A loopback TCP proxy to 127.0.0.1:target; resolves with its port. */
function proxy(target) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const upstream = net.connect(target, "127.0.0.1");
      socket.pipe(upstream);
      upstream.pipe(socket);
      const close = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", close);
      upstream.on("error", close);
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

if (args[0] === "--forwarder") {
  // A detached forward of the master: prints its port, then serves.
  const port = await proxy(Number(args[1]));
  process.stdout.write(`${port}\n`);
  process.stdin.resume();
  process.stdin.on("end", () => {});
} else {
  if (process.env.FAKE_SSH_LOG)
    fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + "\n");
  const option = (name) => {
    for (let i = 0; i < args.length - 1; i++)
      if (args[i] === "-o" && args[i + 1].startsWith(name + "="))
        return args[i + 1].slice(name.length + 1);
  };
  const flag = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const dash = args.indexOf("--");
  const command = dash >= 0 ? args[dash + 2] : undefined;
  const control = option("ControlPath");
  const alive = () => {
    try {
      const pid = Number(fs.readFileSync(control, "utf8"));
      process.kill(pid, 0);
      return pid;
    } catch {
      return 0;
    }
  };
  const forwardFile = (port) => `${control}.fwd.${port}`;
  const remote = flag("-R");
  const target = remote ? Number(remote.split(":").at(-1)) : undefined;
  const mux = flag("-O");

  if (mux) {
    const pid = alive();
    if (mux === "check") process.exit(pid ? 0 : 255);
    if (!pid && mux !== "exit") {
      process.stderr.write(
        "Control socket connect: No such file or directory\n",
      );
      process.exit(255);
    }
    if (mux === "forward" && process.env.FAKE_SSH_FORWARD_FAIL) {
      process.stderr.write("mux_client_forward: forwarding request failed\n");
      process.exit(255);
    }
    if (mux === "forward") {
      const child = spawn(
        process.execPath,
        [self, "--forwarder", String(target)],
        {
          detached: true,
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      const port = await new Promise((resolve) => {
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
          if (out.includes("\n")) resolve(out.trim());
        });
      });
      fs.writeFileSync(forwardFile(port), `${child.pid}\n${target}`);
      child.stdout.destroy();
      child.unref();
      process.stdout.write(`${port}\n`);
      process.exit(0);
    }
    if (mux === "cancel") {
      const listen = remote.split(":")[1];
      const dir = control.slice(0, control.lastIndexOf("/"));
      const base = control.slice(control.lastIndexOf("/") + 1);
      const match = fs
        .readdirSync(dir)
        .filter((name) => name.startsWith(`${base}.fwd.`))
        .find(
          (name) =>
            listen === "0" &&
            fs.readFileSync(`${dir}/${name}`, "utf8").split("\n")[1] ===
              String(target),
        );
      if (!match) {
        process.stderr.write("mux_client_forward: cancel: port not found\n");
        process.exit(255);
      }
      const file = `${dir}/${match}`;
      try {
        process.kill(Number(fs.readFileSync(file, "utf8").split("\n")[0]));
      } catch {}
      fs.rmSync(file, { force: true });
      if (process.env.FAKE_SSH_CANCELLED)
        fs.appendFileSync(
          process.env.FAKE_SSH_CANCELLED,
          `${match.slice(`${base}.fwd.`.length)}\n`,
        );
      process.exit(0);
    }
    // exit: the master and its forwards.
    const dir = control.slice(0, control.lastIndexOf("/"));
    const base = control.slice(control.lastIndexOf("/") + 1);
    for (const name of fs.readdirSync(dir))
      if (name.startsWith(`${base}.fwd.`)) {
        try {
          process.kill(
            Number(fs.readFileSync(`${dir}/${name}`, "utf8").split("\n")[0]),
          );
        } catch {}
        fs.rmSync(`${dir}/${name}`, { force: true });
      }
    if (pid) process.kill(pid);
    fs.rmSync(control, { force: true });
    process.exit(0);
  }

  if (args.includes("-M")) {
    fs.writeFileSync(control, String(process.pid));
    const done = () => {
      fs.rmSync(control, { force: true });
      process.exit(0);
    };
    process.stdin.on("end", done);
    process.stdin.resume();
    process.on("SIGTERM", done);
  } else {
    if (control && control !== "none" && !alive()) {
      process.stderr.write(
        "Control socket connect: No such file or directory\n",
      );
      process.exit(255);
    }
    if (remote && target) {
      const port = await proxy(target);
      const level = (option("LogLevel") ?? "INFO").toUpperCase();
      if (!["QUIET", "FATAL", "ERROR"].includes(level))
        process.stderr.write(
          `Allocated port ${port} for remote forward to 127.0.0.1:${target}\n`,
        );
    }
    const child = spawn("/bin/sh", ["-c", command], {
      env: {
        ...process.env,
        HOME: process.env.FAKE_SSH_HOME ?? process.env.HOME,
      },
      stdio: "inherit",
    });
    process.on("SIGTERM", () => child.kill());
    child.on("exit", (code) => process.exit(code ?? 255));
  }
}
