import type { Settings } from "../../shared/types";
import {
  parseCoarseLocation,
  type CoarseLocation,
} from "../../shared/location-metadata";
import type { EngineExtension } from "../engine/engine-extensions";

/** Default-on coarse location. */
export function locationMetadataExtension(
  settings: () => Pick<Settings, "locationMetadata">,
  lookup: () => Promise<unknown>,
) {
  let location: CoarseLocation | null = null;
  let pending: Promise<void> | undefined;
  const prepare = () => {
    if (settings().locationMetadata === false) return Promise.resolve();
    return (pending ??= (async () => {
      try {
        location = parseCoarseLocation(await lookup());
      } catch {
        location = null;
      }
    })());
  };
  const extension: EngineExtension = {
    id: "location",
    incognito: true,
    prepareTurn: ({ mode }) =>
      mode === "code" ? Promise.resolve() : prepare(),
    turnContext: ({ mode }) => {
      if (mode === "code" || settings().locationMetadata === false || !location)
        return;
      const parts = [location.city, location.region, location.country].filter(
        Boolean,
      );
      return parts.length
        ? { coarse: `Approximate user location: ${parts.join(", ")}.` }
        : undefined;
    },
  };
  return { extension, prepare };
}
