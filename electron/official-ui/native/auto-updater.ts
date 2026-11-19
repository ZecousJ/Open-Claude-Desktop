import { mainState } from "../../app/main-state";
import { isOutboxTurn } from "../../ssh/outbox";
import {
  appUpdater,
  onAppUpdateStatus,
  relaunchToUpdate,
} from "../../updates/launch";
import type { NativeHost } from "./host";

function updaterState() {
  const update = appUpdater()?.status();
  if (!update?.supported || update.phase === "up-to-date")
    return { status: "idle" };

  switch (update.phase) {
    case "checking":
    case "downloading":
      return { status: update.phase, isManualCheck: update.manual ?? false };
    case "ready":
      return {
        status: update.retry ? "install-failed" : "ready",
        version: update.version,
        versionNumber: update.version,
      };
    case "error":
      return { status: "error", errorMessage: update.error };
    case "idle":
      return { status: "idle" };
  }
}

function sessionWork() {
  const running = [];
  let working = 0;
  let withShells = 0;
  for (const session of mainState.store?.conversations ?? []) {
    if (
      session.archived ||
      (session.mode !== "code" && session.mode !== "cowork")
    )
      continue;
    const hasTurn = session.turns.some(
      (turn) => turn.status === "inProgress" && !isOutboxTurn(turn),
    );
    const hasShell = !!mainState.terminals?.busy(session.id).length;
    if (hasTurn) working++;
    if (hasShell) withShells++;
    if (hasTurn || hasShell) {
      running.push({
        sessionId: `local_${session.id}`,
        title: session.title,
        kind: session.mode,
      });
    }
  }
  return { running, working, withShells };
}

export function registerAutoUpdater(host: NativeHost) {
  const domain = "AutoUpdater";
  const store = host.store(domain, "updaterState", updaterState());
  const unsubscribe = onAppUpdateStatus(() => store.set(updaterState()));

  let timer: NodeJS.Timeout | undefined;
  function cancelPendingRestart() {
    clearInterval(timer);
    timer = undefined;
  }

  host.on(`${domain}.checkForUpdates`, async (manual: unknown) => {
    await appUpdater()?.check({ manual: manual === true });
  });
  host.on(`${domain}.getRunningLocalSessions`, () => sessionWork().running);
  host.on(
    `${domain}.getRunningLocalSessionCount`,
    () => sessionWork().running.length,
  );
  host.on(`${domain}.getLocalSessionWorkCounts`, () => {
    const { working, withShells } = sessionWork();
    return { working, withShells };
  });
  host.on(`${domain}.restartToUpdate`, () => {
    cancelPendingRestart();
    if (appUpdater()?.status().phase !== "ready") return false;
    relaunchToUpdate({ interrupt: sessionWork().running.length > 0 });
    return true;
  });
  host.on(`${domain}.restartToUpdateWhenIdle`, (skipShells: unknown) => {
    cancelPendingRestart();
    if (appUpdater()?.status().phase !== "ready") return false;
    const whenIdle = () => {
      if (appUpdater()?.status().phase !== "ready") {
        cancelPendingRestart();
        return;
      }
      if (
        mainState.engine?.isBusy() ||
        (skipShells !== true && sessionWork().withShells > 0)
      )
        return;
      cancelPendingRestart();
      relaunchToUpdate();
    };
    timer = setInterval(whenIdle, 1000);
    timer.unref();
    whenIdle();
    return true;
  });
  host.on(`${domain}.cancelPendingRestart`, cancelPendingRestart);

  return () => {
    cancelPendingRestart();
    unsubscribe();
  };
}
