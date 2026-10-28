/**
 * Site icons (R45c, electron/favicons.ts): only public hosts the policy
 * allows remote images from, only real image bytes, cached per account,
 * redirects checked, and nothing fetched with remote images off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FaviconService,
  faviconFailureTtlMs,
  faviconTtlMs,
  maxFaviconBytes,
  publicHost,
  redirectAllowed,
  sniffIconType,
  type FetchIcon,
} from "../../electron/app/favicons";
import { registerFaviconHandlers } from "../../electron/ipc/favicons";
import type { AppContext } from "../../electron/app/app-context";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
const open = { remoteImages: true, remoteImageDomains: null };

function service(fetchIcon: FetchIcon, now = () => 1_000_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-favicons-"));
  return {
    root,
    service: new FaviconService(root, fetchIcon, now),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("only public DNS names are asked for an icon", () => {
  assert.equal(publicHost("en.wikipedia.org"), "en.wikipedia.org");
  assert.equal(publicHost("Example.COM"), "example.com");
  assert.equal(publicHost("xn--bcher-kva.de"), "xn--bcher-kva.de");
  for (const bad of [
    "localhost",
    "printer.local",
    "router.home.arpa",
    "app.localhost",
    "intranet",
    "127.0.0.1",
    "192.168.1.1",
    "[::1]",
    "::1",
    "example.com:8443",
    "example.com/path",
    "user@example.com",
    "-bad.example",
    "a..b",
    "1.2.3.4.5",
    "",
    "a".repeat(254),
  ])
    assert.equal(publicHost(bad), undefined, bad);
});

test("only known image formats become icons; SVG and HTML do not", () => {
  assert.equal(sniffIconType(png), "image/png");
  assert.equal(sniffIconType(ico), "image/x-icon");
  assert.equal(sniffIconType(Buffer.from("GIF89a..")), "image/gif");
  assert.equal(
    sniffIconType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assert.equal(
    sniffIconType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")),
    "image/webp",
  );
  assert.equal(sniffIconType(Buffer.from("<svg xmlns=...>")), undefined);
  assert.equal(sniffIconType(Buffer.from("<!doctype html>")), undefined);
  assert.equal(sniffIconType(Buffer.from([0])), undefined);
});

test("redirects go only to https on public hosts the policy allows", () => {
  assert.equal(redirectAllowed("https://cdn.example.com/f.ico", open), true);
  assert.equal(redirectAllowed("http://cdn.example.com/f.ico", open), false);
  assert.equal(redirectAllowed("https://10.0.0.1/f.ico", open), false);
  assert.equal(redirectAllowed("https://localhost/f.ico", open), false);
  assert.equal(redirectAllowed("https://a.example:8443/f.ico", open), false);
  assert.equal(redirectAllowed("https://u:p@a.example/f.ico", open), false);
  const listed = { remoteImages: true, remoteImageDomains: ["*.example.com"] };
  assert.equal(redirectAllowed("https://img.example.com/f.ico", listed), true);
  assert.equal(redirectAllowed("https://other.org/f.ico", listed), false);
});

test("icons are fetched once per host and kept as data URLs for a week", async () => {
  const asked: string[] = [];
  let clock = 1_000_000;
  const fetchIcon: FetchIcon = async (url, options) => {
    asked.push(url);
    assert.equal(options.maxBytes, maxFaviconBytes);
    return { status: 200, body: png };
  };
  const env = service(fetchIcon, () => clock);
  try {
    const [first, again] = await Promise.all([
      env.service.icons(["a.example", "a.example", "b.example"], open),
      env.service.icon("a.example", open),
    ]);
    assert.equal(
      first["a.example"],
      `data:image/png;base64,${png.toString("base64")}`,
    );
    assert.equal(again, first["a.example"]);
    assert.deepEqual(asked.sort(), [
      "https://a.example/favicon.ico",
      "https://b.example/favicon.ico",
    ]);
    // A new session reads the account's cache from disk.
    const reopened = new FaviconService(env.root, fetchIcon, () => clock);
    assert.equal(await reopened.icon("a.example", open), first["a.example"]);
    assert.equal(asked.length, 2);
    if (process.platform !== "win32")
      for (const file of fs.readdirSync(path.join(env.root, "favicons")))
        assert.equal(
          fs.statSync(path.join(env.root, "favicons", file)).mode & 0o777,
          0o600,
        );
    clock += faviconTtlMs;
    await reopened.icon("a.example", open);
    assert.equal(asked.length, 3, "asked again after a week");
  } finally {
    env.close();
  }
});

test("failures leave the placeholder and are retried after a day", async () => {
  const bodies: ({ status: number; body: Buffer } | null | Error)[] = [
    { status: 404, body: Buffer.alloc(0) },
    { status: 200, body: Buffer.from("<svg/>") },
    { status: 200, body: Buffer.alloc(maxFaviconBytes + 1, 0) },
    new Error("network"),
    null,
    { status: 200, body: ico },
  ];
  let clock = 0;
  let calls = 0;
  const env = service(
    async () => {
      const next = bodies[calls++];
      if (next instanceof Error) throw next;
      return next;
    },
    () => clock,
  );
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(await env.service.icon("a.example", open), null);
      assert.equal(await env.service.icon("a.example", open), null, "cached");
      clock += faviconFailureTtlMs;
    }
    assert.equal(calls, 5);
    assert.match(
      (await env.service.icon("a.example", open))!,
      /^data:image\/x-icon;base64,/,
    );
  } finally {
    env.close();
  }
});

test("nothing is fetched for hosts the policy or the address rules refuse", async () => {
  let calls = 0;
  const env = service(async () => {
    calls++;
    return { status: 200, body: png };
  });
  try {
    const off = { remoteImages: false, remoteImageDomains: null };
    assert.deepEqual(await env.service.icons(["a.example"], off), {
      "a.example": null,
    });
    const listed = { remoteImages: true, remoteImageDomains: ["a.example"] };
    const icons = await env.service.icons(
      ["a.example", "b.example", "localhost", "10.0.0.2"],
      listed,
    );
    assert.equal(typeof icons["a.example"], "string");
    assert.equal(icons["b.example"], null);
    assert.equal(icons.localhost, null);
    assert.equal(icons["10.0.0.2"], null);
    assert.equal(calls, 1);
  } finally {
    env.close();
  }
});

test("the IPC answers placeholders when signed out or with remote images off", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-favicons-ipc-"));
  let calls = 0;
  let activate: (() => void) | undefined;
  let deactivate: (() => void) | undefined;
  let policy = { remoteImages: false, remoteImageDomains: null };
  const settings = { disableNonessentialServices: false };
  const handlers = new Map<string, (...args: any[]) => any>();
  registerFaviconHandlers(
    (name, fn) => handlers.set(name, fn),
    {
      store: { root, settings },
      policy: () => policy,
      onAccountActivated: (cb: () => void) => {
        activate = cb;
        return () => {};
      },
      onAccountDeactivating: (cb: () => void) => {
        deactivate = cb;
        return () => {};
      },
    } as unknown as AppContext,
    async () => {
      calls++;
      return { status: 200, body: png };
    },
  );
  const get = handlers.get("getFavicons")!;
  try {
    assert.deepEqual(await get(["a.example"]), { "a.example": null });
    activate!();
    assert.deepEqual(await get(["a.example"]), { "a.example": null });
    policy = { remoteImages: true, remoteImageDomains: null };
    assert.equal(typeof (await get(["a.example"]))["a.example"], "string");
    settings.disableNonessentialServices = true;
    assert.deepEqual(await get(["a.example", "blocked.example"]), {
      "a.example": null,
      "blocked.example": null,
    });
    assert.equal(calls, 1);
    settings.disableNonessentialServices = false;
    assert.equal(typeof (await get(["a.example"]))["a.example"], "string");
    deactivate!();
    assert.deepEqual(await get(["a.example"]), { "a.example": null });
    assert.equal(calls, 1);
    await assert.rejects(get(Array(51).fill("a.example")));
    await assert.rejects(get("a.example"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
