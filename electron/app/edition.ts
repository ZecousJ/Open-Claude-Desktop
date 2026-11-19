declare const __CLAUDEX_EDITION__: "local" | "full";

export const localEdition =
  typeof __CLAUDEX_EDITION__ !== "undefined" && __CLAUDEX_EDITION__ === "local";
