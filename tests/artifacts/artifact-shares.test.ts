import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ArtifactShares,
  shareByline,
  sharePage,
  sharePageCsp,
} from "../../electron/artifacts/artifact-shares";

test("local link serves sandboxed snapshots, updates in place, and revokes on private access", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifact-share-"),
  );
  const shares = new ArtifactShares(root);
  const input = {
    identity: '["synthetic","/workspace/card.html"]',
    title: "<Synthetic card>",
    language: "html",
    content: '<button onclick="this.textContent=2">Add 2</button>',
  };
  try {
    await shares.start();
    assert.deepEqual(shares.sync(input), {
      identity: input.identity,
      visibility: "private",
      showInList: true,
    });
    assert.equal(fs.existsSync(path.join(root, "artifact-shares.json")), false);
    const shared = shares.update(input, { visibility: "link" });
    assert.throws(
      () =>
        shares.update(
          { ...input, content: "一".repeat(800000) },
          { showInList: false },
        ),
      /2 MB/,
    );
    assert.equal(shares.list()[0].showInList, true);
    assert.match(
      shared.url!,
      /^http:\/\/127\.0\.0\.1:\d+\/artifact\/[a-f0-9]{64}$/,
    );
    const shell = await fetch(shared.url!);
    assert.equal(shell.status, 200);
    const page = await shell.text();
    assert.match(page, /&lt;Synthetic card&gt;/);
    assert.doesNotMatch(page, /<title><Synthetic/);
    assert.match(page, /sandbox="allow-scripts"/);
    assert.doesNotMatch(page, /allow-same-origin/);
    const documentUrl = shared.url!.replace("/artifact/", "/content/");
    const document = await fetch(documentUrl);
    assert.equal(await document.text(), input.content);
    assert.match(
      document.headers.get("content-security-policy")!,
      /connect-src 'none'; form-action 'none'/,
    );
    assert.equal((await fetch(documentUrl, { method: "POST" })).status, 404);
    assert.equal((await fetch(shared.url! + "?other=1")).status, 404);
    const changed = { ...input, content: "<p>Updated</p>" };
    shares.sync(changed);
    assert.equal(await (await fetch(documentUrl)).text(), changed.content);
    const hidden = shares.update(changed, { showInList: false });
    assert.equal(hidden.showInList, false);
    const privateInfo = shares.update(changed, { visibility: "private" });
    assert.equal(privateInfo.url, undefined);
    assert.equal((await fetch(shared.url!)).status, 404);
    assert.equal((await fetch(documentUrl)).status, 404);
    const stored = fs.readFileSync(
      path.join(root, "artifact-shares.json"),
      "utf8",
    );
    assert.doesNotMatch(stored, /Updated|Add 2/);
    const reshared = shares.update(changed, { visibility: "link" });
    assert.notEqual(reshared.url, shared.url);
    assert.equal((await fetch(shared.url!)).status, 404);
    assert.equal(
      await (
        await fetch(reshared.url!.replace("/artifact/", "/content/"))
      ).text(),
      changed.content,
    );
    await shares.stop();
    const reopened = new ArtifactShares(root);
    await reopened.start();
    try {
      assert.equal(reopened.list()[0].showInList, false);
      assert.equal(
        await (
          await fetch(
            reopened.list()[0].url!.replace("/artifact/", "/content/"),
          )
        ).text(),
        changed.content,
      );
      const oldUrl = reopened.list()[0].url!;
      reopened.remove(input.identity);
      assert.equal((await fetch(oldUrl)).status, 404);
      assert.deepEqual(new ArtifactShares(root).list(), []);
    } finally {
      await reopened.stop();
    }
  } finally {
    await shares.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a copied local link survives a restart on the same port", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifact-share-"),
  );
  const input = {
    identity: '["synthetic","/workspace/card.html"]',
    title: "Card",
    language: "html",
    content: "<p>Card</p>",
  };
  const first = new ArtifactShares(root);
  let second: ArtifactShares | undefined;
  try {
    await first.start();
    const url = first.update(input, { visibility: "link" }).url!;
    await first.stop();
    second = new ArtifactShares(root);
    await second.start();
    assert.equal(second.list()[0].url, url);
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await first.stop();
    await second?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a taken port moves the service instead of failing", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifact-share-"),
  );
  const first = new ArtifactShares(root);
  const second = new ArtifactShares(root);
  try {
    await first.start();
    const port = fs.readFileSync(
      path.join(root, "artifact-shares-port"),
      "utf8",
    );
    await second.start();
    assert.notEqual(
      fs.readFileSync(path.join(root, "artifact-shares-port"), "utf8"),
      port,
    );
  } finally {
    await first.stop();
    await second.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("malformed persisted sharing data is not replaced", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifact-share-"),
  );
  try {
    const filename = path.join(root, "artifact-shares.json");
    fs.writeFileSync(filename, "{broken");
    assert.throws(() => new ArtifactShares(root), /cannot be read/);
    assert.equal(fs.readFileSync(filename, "utf8"), "{broken");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a public link on the service is the artifact's link and keeps its version; Only you stops it", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifact-share-hosted-"),
  );
  const shares = new ArtifactShares(root);
  const links = new Map<string, string>();
  const stopped: string[] = [];
  shares.hosted = {
    link: (identity) => links.get(identity),
    identities: () => [...links.keys()],
    stop: (identity) => {
      stopped.push(identity);
      links.delete(identity);
    },
  };
  const input = {
    identity: '["synthetic","/workspace/public.html"]',
    title: "Public",
    language: "html",
    content: "<p>1</p>",
  };
  try {
    assert.deepEqual(shares.sync(input), {
      identity: input.identity,
      visibility: "private",
      showInList: true,
    });
    links.set(input.identity, "https://share.example.test/s/abc");
    const info = shares.sync({ ...input, content: "<p>2</p>" });
    assert.deepEqual(info, {
      identity: input.identity,
      visibility: "link",
      showInList: true,
      url: "https://share.example.test/s/abc",
      scope: "public",
      publicUrl: "https://share.example.test/s/abc",
      screenshotUrl: undefined,
    });
    // Listed even though this computer has no local link for it.
    assert.deepEqual(
      shares.list().map((item) => [item.identity, item.scope]),
      [[input.identity, "public"]],
    );
    // Hiding it from the Artifacts page keeps it public.
    assert.equal(shares.update(input, { showInList: false }).scope, "public");
    const privateInfo = shares.update(input, { visibility: "private" });
    assert.deepEqual(stopped, [input.identity]);
    assert.equal(privateInfo.visibility, "private");
    assert.equal(privateInfo.scope, undefined);
    assert.equal(privateInfo.showInList, false);
    // Nothing public or local left to stop.
    shares.update(input, { visibility: "private" });
    assert.deepEqual(stopped, [input.identity]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Privacy lists an artifact's local link as local even when it is also public", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifact-share-both-"),
  );
  const shares = new ArtifactShares(root);
  const input = {
    identity: '["synthetic","/workspace/both.html"]',
    title: "Both",
    language: "html",
    content: "<p>1</p>",
  };
  try {
    await shares.start();
    const local = shares.update(input, { visibility: "link" }).url;
    assert.match(
      local ?? "",
      /^http:\/\/127\.0\.0\.1:\d+\/artifact\/[a-f0-9]{64}$/,
    );
    shares.hosted = {
      link: () => "https://share.example.test/s/abc",
      identities: () => [input.identity],
      stop: () => {},
    };
    assert.equal(shares.sync(input).url, "https://share.example.test/s/abc");
    assert.deepEqual(shares.shared(), [
      { identity: input.identity, title: "Both", url: local },
    ]);
  } finally {
    await shares.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local link page follows the live artifact shell and runs only its own nonce script", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-artifact-share-page-"),
  );
  const shares = new ArtifactShares(root);
  const input = {
    identity: '["synthetic","/workspace/page.html"]',
    title: "Page <one>",
    language: "html",
    content: "<p>1</p>",
  };
  try {
    await shares.start();
    const url = shares.update(input, { visibility: "link" }).url!;
    const response = await fetch(url);
    const csp = response.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, csp);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    const page = await response.text();
    assert.ok(page.includes(`<script nonce="${nonce}">`));
    assert.equal(page.match(/<script/g)?.length, 1);
    assert.match(page, /<span class="title">Page &lt;one&gt;<\/span>/);
    assert.ok(page.includes(shareByline));
    assert.match(page, /height:2\.5rem;padding:0 12px/);
    assert.match(page, /prefers-color-scheme:dark/);
    assert.match(page, /class="loading" role="status"/);
    const again = (await fetch(url)).headers.get("content-security-policy")!;
    assert.notEqual(again, csp);
    assert.equal(
      sharePageCsp("n"),
      "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-n'; base-uri 'none'; form-action 'none'",
    );
    assert.ok(sharePage("A", "t", "n").includes('src="/content/t"'));
  } finally {
    await shares.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
