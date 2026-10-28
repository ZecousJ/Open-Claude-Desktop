import test from "node:test";
import assert from "node:assert/strict";

// A Spanish catalog holds no Portuguese: ã, õ and ç do not occur in Spanish
// (the one exception is the language's own name, Français).
for (const id of ["es-ES", "es-419"])
  test(`${id}: no value is Portuguese`, async () => {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    const leaks = Object.entries(catalog)
      .filter(([key, value]) => key !== "Français" && /[ãõç]/.test(value))
      .map(([key]) => key);
    assert.deepEqual(leaks, []);
  });
