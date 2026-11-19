import test from "node:test";
import assert from "node:assert/strict";
import {
  fileReadObserver,
  withFileReadDiagnostics,
  fileReadServiceStage,
} from "../electron/official-ui/api/file-read-diagnostics";
test("fixed schema rejects arbitrary stage/status/error properties and logging cannot change read outcome", () => {
  const lines: unknown[][] = [];
  const observe = fileReadObserver((...args) => lines.push(args));
  observe("SECRET" as any, 200, new Error("secret"));
  assert.equal(lines.length, 0);
  observe("service-error", 987654, {
    name: "SECRET",
    message: "SECRET",
    code: "SECRET",
  });
  assert.equal(
    JSON.stringify(lines),
    '[["[official-ui:file-read]","route=files.contents stage=service-error status=none error=unknown code=none service_status=none"]]',
  );
  const error = new Error("SECRET");
  Object.defineProperty(error, "name", {
    get() {
      throw Error("SECRET");
    },
  });
  assert.doesNotThrow(() => observe("service-error", 503, error));
  let reads = 0;
  const shifting = new Error();
  Object.defineProperty(shifting, "name", {
    get() {
      return reads++ === 0 ? "TypeError" : "SECRET";
    },
  });
  observe("service-error", 503, shifting);
  assert.equal(reads, 0);
  const trapped = new Proxy(new Error("SECRET"), {
    get() {
      reads++;
      throw Error("SECRET");
    },
    getPrototypeOf() {
      reads++;
      throw Error("SECRET");
    },
    getOwnPropertyDescriptor() {
      reads++;
      throw Error("SECRET");
    },
  });
  observe("service-error", 503, trapped);
  assert.equal(reads, 0);
  const abort = new Error("SECRET");
  Object.defineProperty(abort, "name", { value: "AbortError" });
  observe("service-error", 503, abort);
  assert.match(JSON.stringify(lines), /error=AbortError/);
  assert.doesNotMatch(JSON.stringify(lines), /SECRET/);
  assert.doesNotThrow(() =>
    fileReadObserver(() => {
      throw Error("logger unavailable");
    })("response", 200),
  );
});

test("own error classifications execute no accessors and scoped stages end with the request", async () => {
  const logs: unknown[][] = [];
  const observe = fileReadObserver((...args) => logs.push(args));
  let reads = 0;
  const e = new Error("PRIVATE");
  Object.defineProperties(e, {
    code: {
      get() {
        reads++;
        return "ENOENT";
      },
    },
    status: {
      get() {
        reads++;
        return 403;
      },
    },
  });
  observe("service-error", 503, e);
  assert.equal(reads, 0);
  assert.match(String(logs.at(-1)), /code=unknown service_status=none/);
  const denied = Object.assign(new Error("PRIVATE"), {
    code: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
    status: 403,
  });
  observe("service-error", 503, denied);
  assert.match(
    String(logs.at(-1)),
    /code=CLAUDEX_WEB_METHOD_UNAVAILABLE service_status=403/,
  );
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  await withFileReadDiagnostics(observe, async () => {
    fileReadServiceStage("route-cloud");
    setTimeout(() => {
      fileReadServiceStage("local-read");
      finish();
    }, 5);
  });
  const count = logs.length;
  await done;
  assert.equal(logs.length, count);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
});
