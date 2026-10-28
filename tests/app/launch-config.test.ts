/**
 * `.claude/launch.json` (R8-B): reading the format Claude's desktop app
 * writes, the checks on each configuration, adding one without losing the
 * rest, splitting and showing command lines, addresses a server prints,
 * and Detect dev server on sample projects (tests/fixtures/launch).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  formatCommandLine,
  isLocalHostname,
  launchCommandKey,
  launchEntryProblem,
  launchPort,
  launchUrl,
  localUrlsIn,
  parseLaunchConfig,
  relativeInside,
  splitCommandLine,
  stripAnsi,
  stripJsonComments,
  upsertLaunchConfig,
} from "../../shared/launch-config";
import {
  detectDevServers,
  frameworkFor,
  portInScript,
} from "../../electron/browser/dev-server-detect";

const fixtures = path.join(import.meta.dirname, "..", "fixtures", "launch");
const read = (...parts: string[]) =>
  fs.readFileSync(path.join(fixtures, ...parts), "utf8");

test("reads the official launch.json format", () => {
  const result = parseLaunchConfig(read("official", ".claude", "launch.json"));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.extra, { version: "0.0.1" });
  assert.deepEqual(
    result.configurations.map((c) => c.name),
    ["web", "api", "existing"],
  );
  assert.deepEqual(result.configurations[0], {
    name: "web",
    runtimeExecutable: "npm",
    runtimeArgs: ["run", "dev"],
    port: 5173,
  });
  assert.deepEqual(result.configurations[1].env, { DEBUG: "1" });
  assert.equal(result.configurations[1].cwd, "api");
  // A url without a command attaches to a server started elsewhere.
  assert.equal(result.configurations[2].runtimeExecutable, undefined);
  assert.equal(launchPort(result.configurations[2]), 4000);
  assert.equal(launchUrl(result.configurations[0]), "http://localhost:5173");
});

test("reads comments and trailing commas, keeping strings intact", () => {
  const text = read("commented", ".claude", "launch.json");
  assert.throws(() => JSON.parse(text));
  const result = parseLaunchConfig(text);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.configurations[0].runtimeArgs, [
    "dev",
    "--host",
    "http://x//y",
  ]);
  assert.equal(
    stripJsonComments('{"a": "/* not, ] a comment */", // yes\n}'),
    '{"a": "/* not, ] a comment */" \n}',
  );
});

test("reports broken files without throwing", () => {
  assert.match(parseLaunchConfig("{").error ?? "", /isn't valid JSON/);
  assert.match(parseLaunchConfig("[]").error ?? "", /must be an object/);
  assert.match(
    parseLaunchConfig('{"configurations": {}}').error ?? "",
    /must be a list/,
  );
  assert.deepEqual(parseLaunchConfig('{"version":"0.0.1"}').configurations, []);
  assert.equal(parseLaunchConfig('{"version":"0.0.1"}').error, undefined);
  assert.match(
    parseLaunchConfig("x".repeat(300 * 1024)).error ?? "",
    /too large/,
  );
});

test("keeps valid configurations and names the first problem", () => {
  const result = parseLaunchConfig(
    JSON.stringify({
      version: "0.0.1",
      configurations: [
        { name: "ok", runtimeExecutable: "npm", port: 3000 },
        { name: "bad", runtimeExecutable: "npm", port: 70000 },
        { name: "OK", runtimeExecutable: "yarn" },
      ],
    }),
  );
  assert.deepEqual(
    result.configurations.map((c) => c.name),
    ["ok"],
  );
  assert.match(result.error ?? "", /^launch\.json: "bad": "port"/);
  assert.equal(result.invalid.length, 2);
});

test("checks every field of a configuration", () => {
  const ok = { name: "web", runtimeExecutable: "npm", port: 3000 };
  assert.equal(launchEntryProblem(ok), undefined);
  const problems: [Record<string, unknown>, RegExp][] = [
    [{ ...ok, name: "" }, /needs a "name"/],
    [{ ...ok, name: "x".repeat(65) }, /too long/],
    [{ ...ok, runtimeExecutable: " " }, /must be a command/],
    [{ ...ok, runtimeExecutable: "a\nb" }, /line breaks/],
    [{ ...ok, runtimeArgs: "run dev" }, /list of strings/],
    [{ ...ok, runtimeArgs: Array(65).fill("x") }, /at most 64/],
    [{ ...ok, port: 0 }, /from 1 to 65535/],
    [{ ...ok, port: 3000.5 }, /from 1 to 65535/],
    [{ ...ok, url: "ftp://localhost:3000" }, /http:\/\/ or https/],
    [{ ...ok, url: "https://example.com" }, /on this computer/],
    [{ ...ok, url: "http://192.168.1.2:3000" }, /on this computer/],
    [{ ...ok, url: "http://user:pw@localhost:3000" }, /user name/],
    [{ ...ok, url: "http://localhost:4000" }, /doesn't match "port"/],
    [{ ...ok, url: "not a url" }, /valid address/],
    [{ name: "x" }, /needs a "runtimeExecutable"/],
    [{ name: "x", runtimeArgs: ["a"], url: "http://localhost:1" }, /needs a/],
    [{ ...ok, cwd: "../outside" }, /inside this project/],
    [{ ...ok, cwd: "/etc" }, /inside this project/],
    [{ ...ok, cwd: "C:\\Windows" }, /inside this project/],
    [{ ...ok, cwd: "a/../../b" }, /inside this project/],
    [{ ...ok, env: [] }, /must be an object/],
    [{ ...ok, env: { "BAD-NAME": "1" } }, /valid variable name/],
    [{ ...ok, env: { A: 1 } }, /must be text/],
    [
      {
        ...ok,
        env: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`V${i}`, ""]),
        ),
      },
      /at most 32/,
    ],
  ];
  for (const [entry, pattern] of problems)
    assert.match(
      launchEntryProblem(entry) ?? "(none)",
      pattern,
      JSON.stringify(entry),
    );
  // Local addresses with a path, and *.localhost, are fine.
  assert.equal(
    launchEntryProblem({ ...ok, url: "http://app.localhost:3000/admin" }),
    undefined,
  );
  assert.equal(
    launchEntryProblem({ ...ok, url: "http://[::1]:3000" }),
    undefined,
  );
  assert.equal(launchEntryProblem({ ...ok, cwd: "apps/./web" }), undefined);
});

test("local host names", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.1.2.3",
    "[::1]",
    "app.localhost",
  ])
    assert.equal(isLocalHostname(host), true, host);
  for (const host of ["example.com", "10.0.0.1", "localhost.example.com"])
    assert.equal(isLocalHostname(host), false, host);
  assert.equal(relativeInside("."), true);
  assert.equal(relativeInside("a/b/.."), true);
  assert.equal(relativeInside(".."), false);
  assert.equal(relativeInside(""), false);
});

test("adds a configuration and keeps everything else", () => {
  const current = parseLaunchConfig(
    JSON.stringify({
      version: "0.0.1",
      custom: { keep: true },
      configurations: [
        { name: "web", runtimeExecutable: "npm", port: 3000 },
        { name: "broken", port: "x" },
      ],
    }),
  );
  const added = JSON.parse(
    upsertLaunchConfig(current, {
      name: "api",
      runtimeExecutable: "python3",
      runtimeArgs: ["-m", "http.server"],
      port: 8000,
    }),
  );
  assert.equal(added.version, "0.0.1");
  assert.deepEqual(added.custom, { keep: true });
  assert.deepEqual(
    added.configurations.map((c: { name: string }) => c.name),
    ["web", "broken", "api"],
  );
  // The same name (any case) replaces, in place.
  const replaced = JSON.parse(
    upsertLaunchConfig(parseLaunchConfig(JSON.stringify(added)), {
      name: "WEB",
      runtimeExecutable: "pnpm",
      runtimeArgs: ["dev"],
      port: 5173,
    }),
  );
  assert.deepEqual(replaced.configurations[0], {
    name: "WEB",
    runtimeExecutable: "pnpm",
    runtimeArgs: ["dev"],
    port: 5173,
  });
  assert.equal(replaced.configurations.length, 3);
  // Other configurations keep their order and fields this app doesn't know.
  const kept = JSON.parse(
    upsertLaunchConfig(
      parseLaunchConfig(
        JSON.stringify({
          configurations: [
            { name: "broken", port: "x" },
            { name: "web", runtimeExecutable: "npm", autoPort: true },
          ],
        }),
      ),
      { name: "api", runtimeExecutable: "python3", port: 8000 },
    ),
  );
  assert.deepEqual(kept.configurations.slice(0, 2), [
    { name: "broken", port: "x" },
    { name: "web", runtimeExecutable: "npm", autoPort: true },
  ]);
  // A new file.
  const fresh = upsertLaunchConfig(undefined, {
    name: "dev",
    runtimeExecutable: "npm",
    runtimeArgs: ["run", "dev"],
    port: 5173,
  });
  assert.equal(fresh.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(fresh), {
    version: "0.0.1",
    configurations: [
      {
        name: "dev",
        runtimeExecutable: "npm",
        runtimeArgs: ["run", "dev"],
        port: 5173,
      },
    ],
  });
  assert.throws(
    () =>
      upsertLaunchConfig(undefined, {
        name: "x",
        runtimeExecutable: "npm",
        cwd: "../up",
      }),
    /inside this project/,
  );
});

test("splits command lines like a shell, without expanding anything", () => {
  assert.deepEqual(splitCommandLine("npm run dev"), ["npm", "run", "dev"]);
  assert.deepEqual(splitCommandLine("  npm   run  dev  "), [
    "npm",
    "run",
    "dev",
  ]);
  assert.deepEqual(
    splitCommandLine(`node "my server.js" --name 'a b' c\\ d ""`),
    ["node", "my server.js", "--name", "a b", "c d", ""],
  );
  assert.deepEqual(splitCommandLine(`echo "$PORT" '$(x)'`), [
    "echo",
    "$PORT",
    "$(x)",
  ]);
  assert.deepEqual(splitCommandLine(`say "a \\"q\\" b"`), ["say", 'a "q" b']);
  assert.deepEqual(splitCommandLine(""), []);
  assert.throws(() => splitCommandLine(`node "open`), /unclosed quote/);
  for (const words of [
    ["npm", "run", "dev"],
    ["node", "my server.js", "it's", ""],
    ["vite", "--port=5173", "--host", "0.0.0.0"],
  ])
    assert.deepEqual(
      splitCommandLine(formatCommandLine(words[0], words.slice(1))),
      words,
    );
  assert.equal(formatCommandLine("npm", ["run", "dev"]), "npm run dev");
  assert.equal(formatCommandLine("node", ["a b"]), "node 'a b'");
});

test("the approval key changes with anything that changes what runs", () => {
  const base = {
    runtimeExecutable: "npm",
    runtimeArgs: ["run", "dev"],
    env: { A: "1", B: "2" },
  };
  const key = launchCommandKey("/p", base);
  assert.equal(
    launchCommandKey("/p", { ...base, env: { B: "2", A: "1" } }),
    key,
  );
  for (const changed of [
    { ...base, runtimeArgs: ["run", "start"] },
    { ...base, runtimeExecutable: "pnpm" },
    { ...base, env: { A: "1", B: "3" } },
    { ...base, cwd: "web" },
  ])
    assert.notEqual(launchCommandKey("/p", changed), key);
  assert.notEqual(launchCommandKey("/q", base), key);
});

test("finds local addresses servers print", () => {
  const vite =
    "\u001b[32m  ➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n";
  assert.deepEqual(localUrlsIn(vite), ["http://localhost:5173"]);
  assert.deepEqual(
    localUrlsIn(
      "ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000.",
    ),
    ["http://localhost:3000"],
  );
  assert.deepEqual(
    localUrlsIn(
      "Listening on http://127.0.0.1:8000/admin/ and http://[::]:9000",
    ),
    ["http://127.0.0.1:8000/admin/", "http://localhost:9000"],
  );
  assert.deepEqual(localUrlsIn("see https://example.com:443/"), []);
  assert.deepEqual(localUrlsIn("http://localhost:99999"), []);
  assert.equal(stripAnsi("\u001b[1;31mred\u001b[0m"), "red");
});

test("detects dev servers in sample projects", async () => {
  const detect = (name: string) =>
    detectDevServers(path.join(fixtures, name), { platform: "darwin" });
  assert.deepEqual(await detect("vite-pnpm"), [
    {
      name: "dev",
      runtimeExecutable: "pnpm",
      runtimeArgs: ["run", "dev"],
      port: 5173,
    },
  ]);
  assert.deepEqual(await detect("next-yarn"), [
    {
      name: "dev",
      runtimeExecutable: "yarn",
      runtimeArgs: ["dev"],
      port: 3001,
    },
  ]);
  assert.deepEqual(await detect("astro-bun"), [
    {
      name: "dev",
      runtimeExecutable: "bun",
      runtimeArgs: ["run", "start"],
      port: 4321,
    },
  ]);
  assert.deepEqual(await detect("django"), [
    {
      name: "dev",
      runtimeExecutable: "python3",
      runtimeArgs: ["manage.py", "runserver", "8000"],
      port: 8000,
    },
  ]);
  const flask = await detectDevServers(path.join(fixtures, "flask"), {
    platform: "win32",
  });
  assert.equal(flask[0].runtimeExecutable, "python");
  assert.equal(flask[0].port, 5000);
  assert.deepEqual(flask[0].runtimeArgs?.slice(0, 4), [
    "-m",
    "flask",
    "--app",
    "app",
  ]);
  // Subfolders, with the root's lock file; a plain node script is not a dev server.
  assert.deepEqual(await detect("monorepo"), [
    {
      name: "apps/docs",
      runtimeExecutable: "npm",
      runtimeArgs: ["run", "start"],
      port: 3000,
      cwd: "apps/docs",
    },
    {
      name: "apps/web",
      runtimeExecutable: "npm",
      runtimeArgs: ["run", "dev"],
      port: 5174,
      cwd: "apps/web",
    },
  ]);
  assert.deepEqual(await detect("no-server"), []);
  assert.deepEqual(await detect("does-not-exist"), []);
});

test("ports and frameworks from scripts", () => {
  assert.equal(portInScript("vite --port 4000"), 4000);
  assert.equal(portInScript("vite --port=4001"), 4001);
  assert.equal(portInScript("next dev -p 4002"), 4002);
  assert.equal(portInScript("PORT=4003 react-scripts start"), 4003);
  assert.equal(portInScript("tsc -p tsconfig.json"), undefined);
  assert.equal(frameworkFor("ng serve", [])?.port, 4200);
  assert.equal(frameworkFor("node server.js", ["next"])?.name, "Next.js");
  assert.equal(frameworkFor("node server.js", []), undefined);
});

test("Auto-verify is kept in launch.json next to the configurations", async () => {
  const { launchAutoVerify, setLaunchAutoVerify, parseLaunchConfig } =
    await import("../../shared/launch-config");
  const before = parseLaunchConfig(
    JSON.stringify({
      version: "0.0.1",
      note: "kept",
      configurations: [
        {
          name: "web",
          runtimeExecutable: "npm",
          runtimeArgs: ["run", "dev"],
          port: 5173,
        },
      ],
    }),
  );
  assert.equal(launchAutoVerify(before), undefined);
  const after = parseLaunchConfig(setLaunchAutoVerify(before, true));
  assert.equal(launchAutoVerify(after), true);
  assert.equal(after.extra.note, "kept");
  assert.deepEqual(
    after.configurations.map((c) => c.name),
    ["web"],
  );
  assert.equal(
    launchAutoVerify(parseLaunchConfig(setLaunchAutoVerify(after, false))),
    false,
  );
});
