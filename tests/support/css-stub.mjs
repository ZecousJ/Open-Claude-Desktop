/**
 * Stylesheets load as empty modules under the test runner: components import
 * their own CSS so it rides with their chunk in the build (the web first-load
 * budget), and Node cannot load `.css`. `npm test` preloads this with
 * `--import`; to run one file directly, pass the same flag:
 * `npx tsx --import ./tests/support/css-stub.mjs --test tests/<file>.test.ts`.
 */
import { registerHooks } from "node:module";
// Failed DOM-node assertions fail small instead of exhausting memory.
import "./safe-dom-assert.mjs";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});
