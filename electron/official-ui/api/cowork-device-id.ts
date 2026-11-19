import { createHash } from "node:crypto";

/** The original UI uses UUIDs for directory rows and device presence. */
export function officialCoworkDeviceId(owner: string, nativeId: string) {
  const hex = createHash("sha256")
    .update(JSON.stringify(["claudex-official-cowork-device", owner, nativeId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
