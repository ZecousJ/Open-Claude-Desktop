import type { DeviceTrustState } from "../../../shared/remote-devices";
import type { FixtureDomain } from "./index";

/** Explicit disposable local preview; no enrollment or remote device traffic. */
export const trustedDevicesFixture: FixtureDomain = {
  params: { trustedDevices: "some|empty|error" },
  bridge({ params }) {
    let state: DeviceTrustState = {
      requireTrustedDevices: true,
      pending: [],
      trusted:
        params.get("trustedDevices") === "some"
          ? Array.from({ length: 6 }, (_, index) => ({
              id: `preview-client-${index}`,
              name: `Preview browser ${index + 1}`,
              platform: "macOS",
              addedAt: "2026-10-18T10:00:00Z",
              fingerprint: `preview-fingerprint-${index}`,
            }))
          : [],
    };
    const read = () => {
      if (params.get("trustedDevices") === "error")
        throw Error("Synthetic device inventory failure.");
      return structuredClone(state);
    };
    return {
      deviceTrustState: async () => read(),
      setRequireTrustedDevices: async (required) => {
        state = { ...state, requireTrustedDevices: required };
        return read();
      },
      approveDeviceTrust: async () => read(),
      rejectDeviceTrust: async () => read(),
      revokeDeviceTrust: async (id) => {
        state = {
          ...state,
          trusted: state.trusted.filter((client) => client.id !== id),
        };
        return read();
      },
    };
  },
};
