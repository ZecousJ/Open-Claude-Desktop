import {
  consentKey,
  deviceLabel,
  simulatorKindLabel,
  simulatorSupported,
  validDeviceId,
  type SimulatorDevice,
  type SimulatorKind,
} from "../../shared/simulators";
import type { ConsentAnswer } from "./consent";
import { SimulatorError } from "./driver";
import type { SimulatorService } from "./service";

/** The key a device's consent is kept under; an Android emulator by its virtual device. */
export async function keyOf(
  this: SimulatorService,
  kind: SimulatorKind,
  id: string,
) {
  const device = (await this.driver(kind).list()).find(
    (item) => item.id === id || item.avd === id,
  );
  return consentKey(kind, device?.avd ?? device?.id ?? id);
}

export async function hasAccess(
  this: SimulatorService,
  kind: SimulatorKind,
  id: string,
) {
  this.checkId(kind, id);
  return this.deps.consent.has(await this.keyOf(kind, id));
}

/** "Let Claude use it" (or taking it back) in the pane. */
export async function allow(
  this: SimulatorService,
  kind: SimulatorKind,
  id: string,
  allow: boolean,
) {
  this.checkId(kind, id);
  if (allow && (await this.deps.consent.ensureTools()) !== "granted")
    throw new SimulatorError(
      "Re-approve emulator access in Settings > Claudex Code > Mobile simulators",
    );
  this.deps.consent.set(await this.keyOf(kind, id), allow);
}

// -- What Claude calls -----------------------------------------------------

/** Forget the devices a deleted conversation was using. */
export function forget(this: SimulatorService, conversationId: string) {
  this.autoConversations.delete(conversationId);
  for (const key of this.autoNotices)
    if (key.startsWith(`${conversationId}:`)) this.autoNotices.delete(key);
  for (const kind of ["ios", "android"] as const)
    this.current.delete(`${conversationId}:${kind}`);
}

export function forgetDevice(
  this: SimulatorService,
  kind: SimulatorKind,
  id: string,
) {
  this.views.delete(`${kind}:${id}`);
  this.shots.delete(`${kind}:${id}`);
  this.densities.delete(`${kind}:${id}`);
}

/** Why Claude can't use a kind, or undefined when it can. */
export function unavailable(
  this: SimulatorService,
  kind: SimulatorKind,
): string | undefined {
  if (!simulatorSupported(kind, this.deps.platform))
    return kind === "ios"
      ? "Claudex Code iOS Simulator requires macOS."
      : "Claudex Code Android Emulator is not supported on this platform.";
  if (!this.deps.switches()[kind])
    return `${simulatorKindLabel[kind]} access for Claudex is turned off in Settings (Settings → Claudex Code → Mobile simulators → ${simulatorKindLabel[kind]}). The user can turn it back on there.`;
  return undefined;
}

/** The booted device Claude means: the one named, the conversation's own, or the first. */
export async function resolve(
  this: SimulatorService,
  kind: SimulatorKind,
  conversationId: string,
  wanted: string | undefined,
  action: string,
): Promise<SimulatorDevice> {
  const devices = await this.driver(kind).list();
  const booted = devices.filter((device) => device.state === "booted");
  if (wanted) {
    const match = devices.find(
      (device) =>
        device.id === wanted || device.avd === wanted || device.name === wanted,
    );
    if (!match) {
      if (kind === "android" && !validDeviceId(kind, wanted))
        throw new SimulatorError(
          `'${wanted}' is not an Android emulator. Physical devices are not supported.`,
        );
      throw new SimulatorError(
        kind === "ios"
          ? `No simulator named '${wanted}'. Available: ${
              devices
                .slice(0, 8)
                .map((device) => device.name)
                .join(", ") || "none"
            }.`
          : `No AVD named '${wanted}'. Available AVDs: ${
              devices.map((device) => device.avd ?? device.name).join(", ") ||
              "none"
            }. Physical devices are not supported; only Android emulators can be used.`,
      );
    }
    return match;
  }
  const own = this.current.get(`${conversationId}:${kind}`);
  const mine = booted.find(
    (device) => (device.avd ?? device.id) === own || device.id === own,
  );
  const device = mine ?? booted[0];
  if (device) return device;
  throw new SimulatorError(
    kind === "ios"
      ? "No booted simulator found. Boot one with `xcrun simctl boot '<device>'`, or pass `device` to 'attach' to boot it."
      : `No running emulator found. ${
          devices.length
            ? `Pass one of these as 'device' to 'attach' to boot it: ${devices
                .map((item) => item.avd ?? item.name)
                .join(", ")}.`
            : "Start one with `emulator -avd '<name>'`, or create one in Android Studio's Device Manager."
        }`,
  );
}

export async function ensureAccess(
  this: SimulatorService,
  kind: SimulatorKind,
  device: SimulatorDevice,
  auto = false,
): Promise<ConsentAnswer> {
  return this.deps.consent.request({
    auto,
    kind,
    key: consentKey(kind, device.avd ?? device.id),
    label: deviceLabel(device.name),
  });
}
