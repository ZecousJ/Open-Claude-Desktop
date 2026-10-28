import {
  validCustomizeSearchResult,
  type CustomizeSearchAPI,
  type CustomizeSearchRequest,
} from "../../../shared/customize-search";
export interface CustomizeSearchAdapter {
  current(): boolean;
  search(
    request: CustomizeSearchRequest,
  ): ReturnType<CustomizeSearchAPI["customizeSearch"]>;
}
export function createCustomizeSearchAdapter(
  bridge: Partial<CustomizeSearchAPI> | undefined,
  current: () => boolean,
): CustomizeSearchAdapter | undefined {
  if (typeof bridge?.customizeSearch !== "function") return undefined;
  return {
    current,
    async search(request) {
      if (!current())
        throw new Error("The signed-in account changed. Try again.");
      const result = await bridge.customizeSearch!(request);
      if (!current())
        throw new Error("The signed-in account changed. Try again.");
      if (!validCustomizeSearchResult(result))
        throw new Error("Invalid Customize search response.");
      return result;
    },
  };
}
