import {
  codeSettingsWire,
  officialCodeSettingsPath,
  parseOfficialCodeSettings,
  savedCodeSettings,
  type CodeSettingsPatch,
} from "../../shared/official-code-settings";
import { officialUiCapabilitiesPath } from "../../shared/official-ui-web";
import type { Settings } from "../../shared/types";
import { webErrorCodes } from "../../shared/web-protocol";

export type CloudCodeSettingsLease = {
  client: { call(method: string, args: unknown[]): Promise<unknown> };
  userId: number;
  current(): boolean;
  apply(patch: CodeSettingsPatch): void;
};

function json(answer: unknown): unknown {
  if (
    !answer ||
    typeof answer !== "object" ||
    !("status" in answer) ||
    answer.status !== 200 ||
    !("body" in answer) ||
    !(answer.body instanceof Uint8Array)
  )
    throw Error("Cloud Code settings are unavailable.");
  return JSON.parse(new TextDecoder().decode(answer.body));
}

export function createCloudCodeSettings(
  capture: () => CloudCodeSettingsLease | undefined,
) {
  let revision = 0;
  let pending:
    | {
        client: CloudCodeSettingsLease["client"];
        revision: number;
        read: Promise<void>;
      }
    | undefined;
  async function readSettings(lease: CloudCodeSettingsLease, started: number) {
    let patch: CodeSettingsPatch | undefined;
    try {
      const value = json(
        await lease.client.call("officialUiRead", [
          { method: "GET", path: officialCodeSettingsPath },
        ]),
      );
      patch = parseOfficialCodeSettings(value)?.patch;
    } catch {
      return;
    }
    if (lease.current() && revision === started && patch) lease.apply(patch);
  }
  async function refresh(lease = capture()) {
    if (!lease?.current()) return;
    if (pending?.client === lease.client && pending.revision === revision)
      return pending.read;
    const read = readSettings(lease, revision).finally(() => {
      if (pending?.read === read) pending = undefined;
    });
    pending = { client: lease.client, revision, read };
    return read;
  }
  return {
    refresh,
    async save(patch: CodeSettingsPatch) {
      const lease = capture();
      if (!lease) return false;
      let descriptor;
      try {
        descriptor = json(
          await lease.client.call("officialUiRead", [
            { method: "GET", path: officialUiCapabilitiesPath },
          ]),
        );
      } catch (error) {
        if (
          lease.current() &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === webErrorCodes.disabled ||
            error.code === webErrorCodes.notAllowed ||
            error.code === webErrorCodes.methodUnavailable)
        )
          return false;
        throw error;
      }
      if (
        !lease.current() ||
        !descriptor ||
        typeof descriptor !== "object" ||
        !("accountId" in descriptor) ||
        descriptor.accountId !== String(lease.userId) ||
        !("activationLease" in descriptor) ||
        !("mode" in descriptor) ||
        typeof descriptor.activationLease !== "string"
      )
        throw Error("Cloud Code settings are unavailable.");
      if (descriptor.mode === "read-only" || descriptor.mode === "strict-text")
        return false;
      if (descriptor.mode !== "engine-chat")
        throw Error("Cloud Code settings are unavailable.");

      const wire = codeSettingsWire(patch);
      const started = revision;
      const response = await lease.client.call("officialUiAction", [
        {
          method: "PATCH",
          path: "/api/account/settings",
          contentType: "application/json",
          capabilityLease: descriptor.activationLease,
          body: new TextEncoder().encode(JSON.stringify(wire)),
        },
      ]);
      if (
        lease.current() &&
        response &&
        typeof response === "object" &&
        "status" in response &&
        response.status === 501
      )
        return false;
      const saved = parseOfficialCodeSettings(json(response))?.patch;
      if (
        !lease.current() ||
        !saved ||
        saved.codeBranchPrefix !== patch.codeBranchPrefix ||
        saved.prAutoArchive !== patch.prAutoArchive
      )
        throw Error("The Cloud Code settings save could not be confirmed.");
      if (revision === started) {
        revision++;
        lease.apply(saved);
      } else {
        await refresh(lease);
        if (!lease.current()) throw Error("The account activation changed.");
      }
      return true;
    },
    receive(lease: CloudCodeSettingsLease, settings: Settings) {
      if (!lease.current()) return;
      const patch = savedCodeSettings(settings);
      if (
        patch.codeBranchPrefix === undefined &&
        patch.prAutoArchive === undefined
      )
        return;
      revision++;
      lease.apply(patch);
    },
  };
}
