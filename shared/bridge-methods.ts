/**
 * The bridge methods one `shared/<domain>-api.ts` interface declares, as the
 * list the preload script exposes to the window. The compiler checks that
 * every method of the interface is named exactly once, so a method added to a
 * domain's interface cannot be forgotten in the bridge.
 */
export function bridgeMethods<T>(names: {
  [K in keyof T]-?: true;
}): (keyof T & string)[] {
  return Object.keys(names) as (keyof T & string)[];
}
