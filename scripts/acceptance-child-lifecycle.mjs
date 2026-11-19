/** Acceptance launcher lifecycle only. Dependencies are explicit: importing this
 * module never starts or signals a process. Normal application Quit remains the
 * graceful shutdown path; forwarding a signal is not proof of graceful exit. */
export function runAcceptanceChild(
  { command, args, cwd, env, buildSha256 },
  { spawn, signals, log },
) {
  if (
    typeof command !== "string" ||
    !command ||
    !Array.isArray(args) ||
    !args.every((value) => typeof value === "string") ||
    typeof cwd !== "string" ||
    !env ||
    typeof env !== "object" ||
    !/^[a-f0-9]{64}$/.test(buildSha256) ||
    typeof spawn !== "function" ||
    typeof signals?.on !== "function" ||
    typeof signals?.removeListener !== "function" ||
    typeof log !== "function"
  )
    return Promise.reject(Error("Invalid acceptance child configuration."));
  return new Promise((resolve, reject) => {
    let child,
      settled = false,
      forwarded = false,
      spawned = false;
    const pid = () =>
      Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : undefined;
    const report = (event, extra = {}) => {
      try {
        log({ event, childPid: pid(), buildSha256, ...extra });
      } catch {
        /* Diagnostics must not change child ownership or exit behavior. */
      }
    };
    const cleanup = () => {
      signals.removeListener("SIGINT", onInt);
      signals.removeListener("SIGTERM", onTerm);
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      report("exit", { code, signal });
      resolve({ code, signal });
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      report("error");
      // Child errors can contain command/env details: expose only this fixed message.
      reject(
        Error(
          "The acceptance child process failed. Check its own diagnostics.",
        ),
      );
    };
    const forward = (signal) => {
      if (
        settled ||
        forwarded ||
        !pid() ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        return;
      forwarded = true;
      try {
        const sent = child.kill(signal);
        report("signal-forwarded", { signal, sent: sent === true });
      } catch {
        report("signal-forward-failed", { signal });
      }
      // No escalation/retry/group signal: wait for the owned child exit/error.
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    try {
      child = spawn(command, args, { cwd, env, stdio: "inherit" });
      if (
        !child ||
        typeof child.once !== "function" ||
        typeof child.on !== "function" ||
        typeof child.kill !== "function"
      ) {
        fail();
        return;
      }
      child.on("error", () => {
        // A failed signal can emit error while the child is still alive. Keep
        // ownership until exit; never turn that into a force-kill or new spawn.
        if (spawned && !settled) report("child-error");
        else fail();
      });
      child.once("exit", finish);
      child.once("spawn", () => {
        if (settled || spawned) return;
        spawned = true;
        report("spawn");
      });
      signals.on("SIGINT", onInt);
      signals.on("SIGTERM", onTerm);
    } catch {
      fail();
    }
  });
}
