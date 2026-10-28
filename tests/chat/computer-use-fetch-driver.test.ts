import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const script = path.resolve("scripts/computer-use/fetch-driver.mjs");
const sha256 = (data: Buffer | string) =>
  crypto.createHash("sha256").update(data).digest("hex");
const sri = (data: Buffer) =>
  `sha512-${crypto.createHash("sha512").update(data).digest("base64")}`;

type Run = { status: number | null; stdout: string; stderr: string };
function runScript(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

type Fixture = {
  root: string;
  tarball: Buffer;
  files: Record<string, string>;
};

const roots: string[] = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// Builds a synthetic npm-style tarball with a Windows layout.
function makeFixture(extraFiles: Record<string, string> = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cu-fetch-"));
  roots.push(root);
  const pkg = path.join(root, "src", "package");
  const files: Record<string, string> = {
    LICENSE: "MIT License\nfixture\n",
    "dist/windows/amd64/open-computer-use.exe": "fake driver executable\n",
    "dist/windows/amd64/vendor-cursor.png": "not ours\n",
    "dist/linux/amd64/open-computer-use": "linux build\n",
    ...extraFiles,
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(pkg, file)), { recursive: true });
    fs.writeFileSync(path.join(pkg, file), content);
  }
  const archive = path.join(root, "driver.tgz");
  const tar = spawnSync("tar", [
    "-czf",
    archive,
    "-C",
    path.join(root, "src"),
    "package",
  ]);
  assert.equal(tar.status, 0, String(tar.stderr));
  fs.writeFileSync(path.join(root, "NOTICES.md"), "# notices\n");
  return { root, tarball: fs.readFileSync(archive), files };
}

function writeConfig(
  fixture: Fixture,
  url: string,
  patch: (driver: Record<string, any>) => void = () => {},
) {
  const layoutFiles = {
    "open-computer-use.exe": sha256(
      fixture.files["dist/windows/amd64/open-computer-use.exe"],
    ),
  };
  const driver: Record<string, any> = {
    version: "9.9.9",
    license: "MIT",
    homepage: "https://example.invalid/driver",
    commit: "0000000000000000000000000000000000000000",
    tarball: {
      url,
      size: fixture.tarball.length,
      sha256: sha256(fixture.tarball),
      integrity: sri(fixture.tarball),
    },
    licenseFile: {
      path: "package/LICENSE",
      sha256: sha256(fixture.files.LICENSE),
    },
    notices: "NOTICES.md",
    targets: { "win32-x64": "windows-x64" },
    layouts: {
      "windows-x64": {
        source: "package/dist/windows/amd64",
        install: ".",
        executable: "open-computer-use.exe",
        files: layoutFiles,
        exclude: {
          "vendor-cursor.png": {
            sha256: sha256(
              fixture.files["dist/windows/amd64/vendor-cursor.png"],
            ),
            reason: "fixture",
          },
        },
        resign: "none",
      },
    },
    args: ["mcp"],
    env: { base: { OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY: "1" } },
    tools: ["list_apps"],
  };
  patch(driver);
  const config = path.join(fixture.root, "drivers.json");
  fs.writeFileSync(
    config,
    JSON.stringify({ default: "fixture", drivers: { fixture: driver } }),
  );
  return config;
}

// Serves the tarball. When `cutFirst` is set, the first full request is cut off
// halfway so the script has to resume with a range request.
async function serve(body: Buffer, options: { cutFirst?: boolean } = {}) {
  const requests: string[] = [];
  let cut = options.cutFirst ?? false;
  const server = http.createServer((request, response) => {
    const range = request.headers.range;
    requests.push(range ?? "full");
    const match = range && /^bytes=(\d+)-$/.exec(range);
    if (match) {
      const start = Number(match[1]);
      response.writeHead(206, {
        "content-length": body.length - start,
        "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
      });
      response.end(body.subarray(start));
      return;
    }
    if (cut) {
      cut = false;
      response.writeHead(200, { "content-length": body.length });
      response.write(body.subarray(0, Math.floor(body.length / 2)), () =>
        response.destroy(),
      );
      return;
    }
    response.writeHead(200, { "content-length": body.length });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/driver.tgz`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const dirs = (fixture: Fixture) => [
  "--out",
  path.join(fixture.root, "out"),
  "--cache",
  path.join(fixture.root, "cache"),
];

test("installs a verified driver, records a manifest and reuses it", async () => {
  const fixture = makeFixture();
  const server = await serve(fixture.tarball);
  try {
    const config = writeConfig(fixture, server.url);
    const out = path.join(fixture.root, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, ".gitkeep"), "");
    // A previous install (it has a manifest) with a leftover file.
    fs.writeFileSync(path.join(out, "manifest.json"), '{"driver":"old"}');
    fs.writeFileSync(path.join(out, "stale.bin"), "old");
    const args = ["win32", "x64", "--config", config, ...dirs(fixture)];

    const first = await runScript(args);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), [
      ".gitkeep",
      "LICENSE",
      "NOTICES.md",
      "manifest.json",
      "open-computer-use.exe",
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.driver, "fixture");
    assert.equal(manifest.version, "9.9.9");
    assert.equal(manifest.platform, "win32");
    assert.equal(manifest.arch, "x64");
    assert.equal(manifest.executable, "open-computer-use.exe");
    assert.equal(manifest.signature, "upstream");
    assert.deepEqual(manifest.removed, ["vendor-cursor.png"]);
    assert.deepEqual(manifest.args, ["mcp"]);
    assert.equal(
      manifest.executableSha256,
      sha256(fixture.files["dist/windows/amd64/open-computer-use.exe"]),
    );

    const second = await runScript(args);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already installed/);
    assert.equal(server.requests.length, 1, "cached tarball is reused");

    assert.deepEqual(Object.keys(manifest.installedFiles).sort(), [
      "LICENSE",
      "NOTICES.md",
      "open-computer-use.exe",
    ]);

    // A missing or added file is not trusted either.
    fs.rmSync(path.join(out, "LICENSE"));
    const missing = await runScript(args);
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /Installed/);
    assert.ok(fs.existsSync(path.join(out, "LICENSE")));
    fs.writeFileSync(path.join(out, "extra.dll"), "?");
    const added = await runScript(args);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /Installed/);
    assert.equal(fs.existsSync(path.join(out, "extra.dll")), false);

    // A modified executable is not trusted: the driver is installed again.
    fs.writeFileSync(path.join(out, "open-computer-use.exe"), "tampered");
    const third = await runScript(args);
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stdout, /Installed/);
    assert.equal(
      fs.readFileSync(path.join(out, "open-computer-use.exe"), "utf8"),
      fixture.files["dist/windows/amd64/open-computer-use.exe"],
    );
  } finally {
    await server.close();
  }
});

test("refuses to clear an unrelated non-empty output directory", async () => {
  const fixture = makeFixture();
  const server = await serve(fixture.tarball);
  try {
    const config = writeConfig(fixture, server.url);
    const out = path.join(fixture.root, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "important.txt"), "not ours");
    const result = await runScript([
      "win32",
      "x64",
      "--config",
      config,
      ...dirs(fixture),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to clear/);
    assert.equal(
      fs.readFileSync(path.join(out, "important.txt"), "utf8"),
      "not ours",
    );
  } finally {
    await server.close();
  }
});

test("resumes an interrupted download with a range request", async () => {
  const fixture = makeFixture();
  const server = await serve(fixture.tarball, { cutFirst: true });
  try {
    const config = writeConfig(fixture, server.url);
    const result = await runScript(
      ["win32", "x64", "--config", config, ...dirs(fixture)],
      { CLAUDEX_CU_DOWNLOAD_ATTEMPTS: "3" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(server.requests[0], "full");
    assert.match(server.requests[1] ?? "", /^bytes=\d+-$/);
    assert.ok(
      fs.existsSync(path.join(fixture.root, "out", "open-computer-use.exe")),
    );
  } finally {
    await server.close();
  }
});

test("rejects a tarball whose SHA-256 does not match and leaves the output alone", async () => {
  const fixture = makeFixture();
  const server = await serve(fixture.tarball);
  try {
    const config = writeConfig(fixture, server.url, (driver) => {
      driver.tarball.sha256 = "0".repeat(64);
    });
    const out = path.join(fixture.root, "out");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "keep-me"), "previous build");
    const result = await runScript([
      "win32",
      "x64",
      "--config",
      config,
      ...dirs(fixture),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 mismatch/);
    assert.equal(
      fs.readFileSync(path.join(out, "keep-me"), "utf8"),
      "previous build",
    );
    assert.deepEqual(
      fs
        .readdirSync(path.join(fixture.root, "cache"))
        .filter((f) => f.endsWith(".tgz")),
      [],
      "the bad download is deleted",
    );
  } finally {
    await server.close();
  }
});

test("rejects a bad npm integrity, a changed file and an unexpected file", async () => {
  const cases: {
    name: string;
    extra?: Record<string, string>;
    patch: (driver: Record<string, any>) => void;
    error: RegExp;
  }[] = [
    {
      name: "integrity",
      patch: (driver) => {
        driver.tarball.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
      },
      error: /Integrity check failed/,
    },
    {
      name: "file hash",
      patch: (driver) => {
        driver.layouts["windows-x64"].files["open-computer-use.exe"] =
          "1".repeat(64);
      },
      error:
        /SHA-256 mismatch for package\/dist\/windows\/amd64\/open-computer-use.exe/,
    },
    {
      name: "unexpected file",
      extra: { "dist/windows/amd64/surprise.dll": "?" },
      patch: () => {},
      error: /unexpected file: package\/dist\/windows\/amd64\/surprise.dll/,
    },
    {
      name: "license",
      patch: (driver) => {
        driver.licenseFile.sha256 = "2".repeat(64);
      },
      error: /License file/,
    },
  ];
  for (const item of cases) {
    const fixture = makeFixture(item.extra);
    const server = await serve(fixture.tarball);
    try {
      const config = writeConfig(fixture, server.url, item.patch);
      const result = await runScript([
        "win32",
        "x64",
        "--config",
        config,
        ...dirs(fixture),
      ]);
      assert.notEqual(result.status, 0, item.name);
      assert.match(result.stderr, item.error, item.name);
      assert.equal(
        fs.existsSync(path.join(fixture.root, "out", "manifest.json")),
        false,
        item.name,
      );
    } finally {
      await server.close();
    }
  }
});

test("download-only verifies without touching the output directory", async () => {
  const fixture = makeFixture();
  const server = await serve(fixture.tarball);
  try {
    const config = writeConfig(fixture, server.url);
    const result = await runScript([
      "win32",
      "x64",
      "--download-only",
      "--config",
      config,
      ...dirs(fixture),
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Download-only/);
    assert.equal(fs.existsSync(path.join(fixture.root, "out")), false);
  } finally {
    await server.close();
  }
});

test("refuses unsafe configuration before downloading", async () => {
  const fixture = makeFixture();
  const cases: [string, (driver: Record<string, any>) => void, RegExp][] = [
    [
      "http://registry.example.invalid/driver.tgz",
      () => {},
      /must be downloaded over HTTPS/,
    ],
    [
      "http://127.0.0.1:9/driver.tgz",
      (driver) => {
        driver.layouts["windows-x64"].install = "../escape";
      },
      /Invalid install path/,
    ],
    [
      "http://127.0.0.1:9/driver.tgz",
      (driver) => {
        driver.targets = {};
      },
      /has no build for win32-x64/,
    ],
  ];
  for (const [url, patch, error] of cases) {
    const config = writeConfig(fixture, url, patch);
    const result = await runScript([
      "win32",
      "x64",
      "--config",
      config,
      ...dirs(fixture),
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  }
});

test("the pinned drivers.json is complete for every packaged target", () => {
  const config = JSON.parse(
    fs.readFileSync("scripts/computer-use/drivers.json", "utf8"),
  );
  const driver = config.drivers[config.default];
  assert.equal(config.default, "open-computer-use");
  assert.equal(driver.license, "MIT");
  assert.match(driver.tarball.url, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(driver.tarball.sha256, /^[0-9a-f]{64}$/);
  assert.match(driver.tarball.integrity, /^sha512-/);
  assert.match(driver.commit, /^[0-9a-f]{40}$/);
  // Claudex packages macOS (both architectures) and Windows x64.
  for (const target of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
    const layout = driver.layouts[driver.targets[target]];
    assert.ok(layout, target);
    assert.match(layout.files[layout.executable], /^[0-9a-f]{64}$/, target);
  }
  assert.equal(driver.layouts.macos.resign, "adhoc");
  assert.ok(
    fs.existsSync(path.join("scripts/computer-use", driver.notices)),
    "notices file exists",
  );
  // The in-process mode keeps Claudex as the only caller of the driver.
  assert.equal(driver.env.base.OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY, "1");
  assert.equal(
    driver.env.base.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS,
    "0",
  );
});
