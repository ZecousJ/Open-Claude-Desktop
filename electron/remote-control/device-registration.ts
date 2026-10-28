import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DeviceInfo } from "../../shared/remote-devices";

/** Durable account-scoped registration of this task host. Inventory reads
 * never rewrite dates; last seen advances only for actual host activity. */
export class DeviceRegistration {
  private readonly file: string;
  private info: DeviceInfo;
  constructor(
    directory: string,
    accountScope: string,
    identity: Pick<DeviceInfo, "id" | "name" | "platform" | "version">,
    private now: () => number = Date.now,
  ) {
    if (!accountScope) throw new Error("A device account is required.");
    const key = createHash("sha256").update(accountScope).digest("hex");
    this.file = path.join(directory, `device-registration-${key}.json`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const at = new Date(now()).toISOString();
    let saved: DeviceInfo | undefined;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      // A renewed link id is a new device: it starts over instead of failing
      // every call on this computer.
      if (saved?.id !== identity.id) saved = undefined;
      else if (
        !Number.isFinite(Date.parse(saved.addedAt ?? "")) ||
        !Number.isFinite(Date.parse(saved.lastSeenAt ?? "")) ||
        !Number.isFinite(Date.parse(saved.connectedAt))
      )
        throw new Error("Invalid saved device registration.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.info = {
      ...(saved ?? { connectedAt: at, addedAt: at, lastSeenAt: at }),
      ...identity,
    };
    this.write(this.info);
  }
  private write(value: DeviceInfo) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.info = value;
  }
  observed(connected = false) {
    const at = new Date(this.now()).toISOString();
    this.write({
      ...this.info,
      ...(connected ? { connectedAt: at } : {}),
      lastSeenAt: at,
    });
  }
  snapshot(online: boolean, computerAccess: boolean): DeviceInfo {
    return { ...this.info, online, computerAccess };
  }
}
