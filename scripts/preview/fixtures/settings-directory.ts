/**
 * Settings → Plugins and Extensions. These pages have no Claudex backend: they
 * browse the static catalogue in src/settings/directory/catalogue.ts and call
 * no bridge methods of their own. The rest of each state is opened by clicking
 * (the pages keep it in React state): Plugins Discover, Add ⌄, Add marketplace
 * → Add from a repository, a category's Show all; Extensions Advanced settings.
 * Design systems (collections fixture) keep theirs in memory.
 *
 * URL parameters:
 * - `directoryTheme=light` start in the light theme
 */
import type { FixtureDomain } from "./index";

export const settingsDirectoryFixture: FixtureDomain = {
  params: {
    directoryTheme: "light: start in the light theme",
  },
  bridge: ({ params, state }) => {
    if (params.get("directoryTheme") === "light")
      state.settings.theme = "light";
    return {};
  },
};
