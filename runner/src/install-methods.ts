/** Puts functions that take `this` on a prototype the way class methods sit there. */
export function installMethods(prototype: object, methods: object) {
  for (const [name, value] of Object.entries(methods))
    if (typeof value === "function")
      Object.defineProperty(prototype, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
}
