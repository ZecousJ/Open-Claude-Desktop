import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  HostedShares,
  type SharingService,
} from "../../electron/artifacts/hosted-shares";
import {
  sourceKeyOf,
  versionKeyOf,
} from "../../electron/artifacts/hosted-shares-support";
import { buildArtifactSnapshot } from "../../electron/conversations/conversation-snapshot";
import type { CreateShareBody } from "../../shared/sharing";
import type {
  HostedShare,
  ShareKind,
  SharingStatus,
} from "../../shared/sharing-api";
import type { Conversation } from "../../shared/types";

const status: SharingStatus = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxArtifactBytes: 2 * 1024 * 1024,
};

/** A service in memory: what the client sent, and shares as the service keeps them. */
function fakeService() {
  const shares: HostedShare[] = [];
  const bodies: CreateShareBody[] = [];
  const calls: string[] = [];
  let next = 1;
  const service: SharingService & {
    online: boolean;
    status_: SharingStatus | null;
  } = {
    online: true,
    status_: status,
    async status() {
      calls.push("status");
      if (!this.online) throw new Error("offline");
      return this.status_;
    },
    async create(body) {
      calls.push(`create ${body.kind}`);
      bodies.push(structuredClone(body));
      let share = shares.find(
        (s) => s.kind === body.kind && s.sourceKey === body.source_key,
      );
      if (!share) {
        share = {
          id: String(next),
          kind: body.kind,
          sourceKey: body.source_key,
          title: body.title,
          url: `https://share.example.test/s/${next++}`,
          createdAt: 1000,
          snapshotAt: 1000,
          status: "active",
          ...(body.access === "invited"
            ? { access: "invited" as const, invites: [] }
            : {}),
        };
        shares.push(share);
      }
      share.title = body.title;
      return structuredClone(share);
    },
    async list(kind?: ShareKind) {
      calls.push("list");
      return structuredClone(shares.filter((s) => !kind || s.kind === kind));
    },
    async revoke(id) {
      calls.push(`revoke ${id}`);
      const index = shares.findIndex((s) => s.id === id);
      if (index >= 0) shares.splice(index, 1);
    },
    async setAccess(id, access) {
      calls.push(`access ${id} ${access}`);
      const share = shares.find((s) => s.id === id)!;
      if (access === "invited") {
        share.access = "invited";
        share.invites ??= [];
      } else delete share.access;
      return structuredClone(share);
    },
    async invite(id, email) {
      calls.push(`invite ${id} ${email}`);
      const share = shares.find((s) => s.id === id)!;
      share.invites ??= [];
      const added = !share.invites.includes(email);
      if (added) share.invites.push(email);
      return { share: structuredClone(share), added, mailed: true };
    },
    async uninvite(id, email) {
      calls.push(`uninvite ${id} ${email}`);
      const share = shares.find((s) => s.id === id)!;
      share.invites = (share.invites ?? []).filter((e) => e !== email);
      return structuredClone(share);
    },
    async sharedWithMe() {
      return [];
    },
    async readShared() {
      throw new Error("not used");
    },
    async reportShared(token, report) {
      calls.push(`report ${token} ${report.category}`);
    },
  };
  return { service, shares, bodies, calls };
}

function setup(t: TestContext, root?: string) {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), "claudex-hosted-"));
  if (!root) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = fakeService();
  const changes: [ShareKind, string | undefined][] = [];
  const conversations: Conversation[] = [];
  let now = 10_000;
  const hosted = new HostedShares({
    service: fake.service,
    root: dir,
    conversation: (id) => conversations.find((c) => c.id === id),
    changed: (kind, key) => changes.push([kind, key]),
    now: () => now,
  });
  t.after(() => hosted.close());
  return {
    ...fake,
    hosted,
    changes,
    conversations,
    dir,
    advance: (ms: number) => (now += ms),
  };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const card = {
  identity: JSON.stringify(["c-1", "/workspace/card.html"]),
  title: "Card",
  language: "html",
  content: "<p>1</p>",
};

test("Code sharing includes a local checkout's GitHub repository for access checks", async (context) => {
  const env = setup(context);
  const cwd = path.join(env.dir, "checkout");
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".git", "config"),
    '[remote "origin"]\nurl = git@github.com:octo/project.git\n',
  );
  env.conversations.push({
    id: "code",
    title: "Code",
    mode: "code",
    cwd,
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "t",
        prompt: "Work",
        items: [],
        attachments: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  } as Conversation);
  await env.hosted.shareConversation("code");
  assert.deepEqual(env.bodies[0].snapshot.repositories, ["octo/project"]);
});

test("artifact Share is separate from Publish: version links are immutable and the latest link follows manual shares", async (context) => {
  const { hosted, bodies } = setup(context);
  const published = await hosted.publishArtifact(card);
  const first = await hosted.shareArtifact(card, false);
  assert.ok(first.share);
  assert.notEqual(first.share.id, published.id);
  assert.equal(first.versions.length, 1);
  const changed = { ...card, content: "<p>2</p>" };
  const second = await hosted.shareArtifact(changed, false);
  assert.equal(second.share?.url, first.share.url);
  assert.equal(second.versions.length, 2);
  assert.equal(second.versions[0].share.url, first.versions[0].share.url);
  assert.equal(
    bodies.filter((body) => body.source_key === bodies[1].source_key).length,
    1,
  );
  assert.equal((await hosted.publication(card))?.share?.id, published.id);
  await hosted.unshareArtifact(card.identity);
  assert.equal((await hosted.artifactShareState(changed)).share, null);
  assert.equal((await hosted.publication(card))?.share?.id, published.id);
  const reshared = await hosted.shareArtifact(changed, false);
  assert.ok(reshared.share);
  await hosted.unpublishArtifact(card.identity);
  assert.equal(
    (await hosted.artifactShareState(changed)).share?.id,
    reshared.share.id,
  );
});

test("artifact access is enforced on latest and version links, and automatic updates retain the audience", async (context) => {
  const { hosted, bodies } = setup(context);
  const privateShare = await hosted.shareArtifact(card, true, "invited");
  assert.equal(privateShare.share?.access, "invited");
  assert.ok(
    privateShare.versions.every(
      (version) => version.share.access === "invited",
    ),
  );
  assert.ok(bodies.every((body) => body.access === "invited"));
  await hosted.inviteToArtifact(privateShare.share!.id, "person@example.com");
  const publicShare = await hosted.setArtifactShareAccess(card, "link");
  assert.equal(publicShare.share?.access, undefined);
  assert.ok(
    publicShare.versions.every((version) => version.share.access === undefined),
  );
  await hosted.setArtifactShareAccess(card, "invited");
  const changed = { ...card, content: "<p>Private update</p>" };
  const updated = await hosted.shareArtifact(changed, true);
  assert.equal(updated.share?.access, "invited");
  assert.ok(
    updated.versions.every((version) => version.share.access === "invited"),
  );
});

test("restricting artifact access waits for an in-flight share and also restricts its new version", async (context) => {
  const { hosted, service } = setup(context);
  await hosted.shareArtifact(card, true);
  const create = service.create.bind(service);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  service.create = async (body) => {
    entered();
    await gate;
    return create(body);
  };
  const changed = { ...card, content: "<p>In flight</p>" };
  const sharing = hosted.shareArtifact(changed, true);
  await started;
  const restricting = hosted.setArtifactShareAccess(changed, "invited");
  release();
  await sharing;
  const state = await restricting;
  assert.equal(state.share?.access, "invited");
  assert.ok(
    state.versions.every((version) => version.share.access === "invited"),
  );
});

test("automatic artifact sharing persists, follows captured changes without the dialog, and stops when switched off or unshared", async (context) => {
  const { hosted, bodies, service, dir } = setup(context);
  const first = await hosted.shareArtifact(card, true);
  assert.equal(first.autoUpdate, true);
  await hosted.syncAutoArtifact(card);
  assert.equal(bodies.length, 2);
  await hosted.syncAutoArtifact({ ...card, content: "<p>automatic</p>" });
  const latest = await hosted.artifactShareState(card);
  assert.equal(latest.share?.url, first.share?.url);
  assert.equal(latest.versions.length, 2);
  const reopened = new HostedShares({
    service,
    root: dir,
    conversation: () => undefined,
    changed: () => {},
  });
  context.after(() => reopened.close());
  assert.equal((await reopened.artifactShareState(card)).autoUpdate, true);
  await hosted.setArtifactAutoShare(card, false);
  const count = bodies.length;
  await hosted.syncAutoArtifact({ ...card, content: "<p>private update</p>" });
  assert.equal(bodies.length, count);
  await hosted.unshareArtifact(card.identity);
  await hosted.syncAutoArtifact(card);
  assert.equal((await hosted.artifactShareState(card)).share, null);
});

test("Unshare cancels in-flight sharing without resurrecting links", async (context) => {
  const { hosted, service, shares } = setup(context);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = service.create.bind(service);
  service.create = async (body) => {
    started();
    await gate;
    return create(body);
  };
  const sharing = hosted.shareArtifact(card, true);
  await entered;
  const stopped = hosted.unshareArtifact(card.identity);
  const rejected = assert.rejects(sharing, /stopped/);
  release();
  await rejected;
  await stopped;
  assert.equal(shares.length, 0);
  assert.equal((await hosted.artifactShareState(card)).autoUpdate, false);
});

test("each published version keeps a link of its own", async (t) => {
  const { hosted, bodies } = setup(t);
  assert.deepEqual(await hosted.publication(card), {
    share: null,
    liveLinks: 0,
    unpublished: false,
  });
  const first = await hosted.publishArtifact(card);
  assert.equal(first.url, "https://share.example.test/s/1");
  assert.equal(first.sourceKey, card.identity);
  // The service keeps a hash of the identity and the version, nothing else.
  assert.equal(bodies[0].source_key, versionKeyOf(card));
  assert.notEqual(bodies[0].source_key, sourceKeyOf("artifact", card.identity));
  assert.ok(!JSON.stringify(bodies).includes("/workspace/card.html"));
  const shown = await hosted.publication(card);
  assert.equal(shown?.share?.id, first.id);
  assert.equal(shown?.liveLinks, 1);
  // The same version again answers its link without uploading.
  assert.equal((await hosted.publishArtifact(card)).id, first.id);
  assert.equal(bodies.length, 1);
  // A changed artifact is a new version: unpublished until it is published.
  const next = { ...card, content: "<p>2</p>" };
  assert.deepEqual(await hosted.publication(next), {
    share: null,
    liveLinks: 1,
    unpublished: false,
  });
  const second = await hosted.publishArtifact(next);
  assert.notEqual(second.id, first.id);
  assert.equal(bodies[1].snapshot.artifacts![0].content, "<p>2</p>");
  assert.equal((await hosted.publication(card))?.liveLinks, 2);
  // The newest link is the artifact's link; one artifact is listed once.
  assert.equal(hosted.link(card.identity), second.url);
  assert.deepEqual(hosted.identities(), [card.identity]);
});

test("artifact invites grant collaboration without restricting or revoking the public link", async (t) => {
  const { hosted, calls, changes } = setup(t);
  const published = await hosted.publishArtifact(card);
  const result = await hosted.inviteToArtifact(
    published.id,
    "person@example.com",
  );
  assert.equal(result.added, true);
  assert.deepEqual(result.share.invites, ["person@example.com"]);
  assert.equal(result.share.access, undefined);
  assert.equal(result.share.url, published.url);
  assert.deepEqual(changes.at(-1), ["artifact", card.identity]);
  const removed = await hosted.removeArtifactInvite(
    published.id,
    "person@example.com",
  );
  assert.deepEqual(removed.invites, []);
  assert.equal(removed.url, published.url);
  assert.equal((await hosted.publication(card))?.share?.id, published.id);
  assert.ok(calls.includes(`invite ${published.id} person@example.com`));
  assert.ok(
    !calls.some(
      (call) => call.startsWith("access ") || call.startsWith("revoke "),
    ),
  );
});

test("Unpublish removes every version's link, and those versions stay unpublished", async (t) => {
  const { hosted, shares, calls, changes, dir, service } = setup(t);
  const next = { ...card, content: "<p>2</p>" };
  await hosted.publishArtifact(card);
  await hosted.publishArtifact(next);
  await hosted.unpublishArtifact(card.identity);
  assert.equal(shares.length, 0);
  assert.ok(calls.includes("revoke 1") && calls.includes("revoke 2"));
  assert.deepEqual(changes.at(-1), ["artifact", card.identity]);
  assert.equal(hosted.link(card.identity), undefined);
  assert.deepEqual(await hosted.publication(card), {
    share: null,
    liveLinks: 0,
    unpublished: true,
  });
  await assert.rejects(
    hosted.publishArtifact(next),
    /previously unpublished\. Create a new artifact to publish again/,
  );
  // A new version can be published.
  const third = { ...card, content: "<p>3</p>" };
  assert.equal((await hosted.publishArtifact(third)).status, "active");
  // This computer remembers what was unpublished.
  hosted.close();
  const again = new HostedShares({
    service,
    root: dir,
    conversation: () => undefined,
    changed: () => {},
  });
  t.after(() => again.close());
  assert.equal((await again.publication(card))?.unpublished, true);
  assert.equal((await again.publication(third))?.unpublished, false);
});

test("a link made before versions counts for the version it last uploaded", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-hosted-legacy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacyKey = sourceKeyOf("artifact", card.identity);
  const digest = createHash("sha256")
    .update(JSON.stringify(buildArtifactSnapshot(card, status)))
    .digest("hex");
  fs.writeFileSync(
    path.join(dir, "hosted-shares.json"),
    JSON.stringify({
      version: 1,
      sources: {
        [legacyKey]: { kind: "artifact", source: card.identity, digest },
      },
    }),
  );
  const { hosted, shares, calls } = setup(t, dir);
  shares.push({
    id: "9",
    kind: "artifact",
    sourceKey: legacyKey,
    title: "Card",
    url: "https://share.example.test/s/9",
    createdAt: 1000,
    snapshotAt: 1000,
    status: "active",
  });
  assert.equal((await hosted.publication(card))?.share?.id, "9");
  const other = await hosted.publication({ ...card, content: "<p>2</p>" });
  assert.equal(other?.share, null);
  assert.equal(other?.liveLinks, 1);
  // Publishing that version answers the old link.
  assert.equal((await hosted.publishArtifact(card)).id, "9");
  await hosted.unpublishArtifact(card.identity);
  assert.ok(calls.includes("revoke 9"));
  assert.equal(shares.length, 0);
});

test("a taken-down version is not published again, and its link is not offered", async (t) => {
  const { hosted, shares, bodies } = setup(t);
  await hosted.publishArtifact(card);
  shares[0].status = "disabled";
  shares[0].disabledReason = "Spam";
  await hosted.list(undefined, true);
  assert.equal(hosted.link(card.identity), undefined);
  assert.deepEqual(hosted.identities(), []);
  const shown = await hosted.publication(card);
  assert.equal(shown?.share?.status, "disabled");
  assert.equal(shown?.liveLinks, 0);
  await assert.rejects(hosted.publishArtifact(card), /administrator removed/);
  assert.equal(bodies.length, 1);
});

test("revoking a link removes Open in web at once", async (t) => {
  const { hosted, changes } = setup(t);
  const share = await hosted.publishArtifact(card);
  assert.ok((await hosted.find(share.id))?.url);
  await hosted.revoke(share.id);
  assert.equal(hosted.link(card.identity), undefined);
  assert.equal(await hosted.find(share.id), undefined);
  assert.deepEqual(changes.at(-1), ["artifact", card.identity]);
});

test("Only you stops the public link, and a failure shows the truth again", async (t) => {
  const { hosted, service, calls, changes } = setup(t);
  await hosted.publishArtifact(card);
  hosted.stop(card.identity);
  assert.equal(hosted.link(card.identity), undefined);
  await wait(10);
  assert.ok(calls.includes("revoke 1"));
  await hosted.publishArtifact(card);
  service.revoke = async () => {
    throw new Error("offline");
  };
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  hosted.stop(card.identity);
  await wait(20);
  assert.equal(errors.length, 1);
  assert.equal(hosted.link(card.identity), "https://share.example.test/s/2");
  assert.deepEqual(changes.at(-1), ["artifact", card.identity]);
});

test("sources are remembered in the profile, and links from elsewhere have none", async (t) => {
  const first = setup(t);
  await first.hosted.publishArtifact(card);
  first.conversations.push({
    id: "c-9",
    title: "Chat",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "t-1",
        prompt: "Hi",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
    ],
  });
  await first.hosted.shareConversation("c-9");
  const stored = fs.readFileSync(
    path.join(first.dir, "hosted-shares.json"),
    "utf8",
  );
  assert.equal(
    (
      fs.statSync(path.join(first.dir, "hosted-shares.json")).mode & 0o777
    ).toString(8),
    "600",
  );
  assert.match(stored, /c-9/);
  first.hosted.close();
  // The next run on this computer knows them; the service list is the same.
  const second = new HostedShares({
    service: {
      ...first.service,
      list: async () => structuredClone(first.shares),
    },
    root: first.dir,
    conversation: (id) => first.conversations.find((c) => c.id === id),
    changed: () => {},
  });
  const listed = await second.list();
  assert.deepEqual(
    listed.map((s) => s.sourceKey).sort(),
    [card.identity, "c-9"].sort(),
  );
  assert.equal(second.link(card.identity), "https://share.example.test/s/1");
  assert.equal((await second.conversationShare("c-9"))?.stale, undefined);
  // Another computer does not know where the links came from.
  const elsewhere = new HostedShares({
    service: {
      ...first.service,
      list: async () => structuredClone(first.shares),
    },
    root: fs.mkdtempSync(path.join(os.tmpdir(), "claudex-hosted-other-")),
    conversation: () => undefined,
    changed: () => {},
  });
  assert.deepEqual(
    (await elsewhere.list()).map((s) => s.sourceKey),
    ["", ""],
  );
  assert.deepEqual(elsewhere.identities(), []);
});

test("the status is cached for a minute and survives a short outage", async (t) => {
  const { hosted, service, calls, advance } = setup(t);
  assert.deepEqual(await hosted.status(), status);
  await hosted.status();
  assert.equal(calls.filter((c) => c === "status").length, 1);
  advance(61_000);
  service.online = false;
  assert.deepEqual(await hosted.status(), status);
  service.online = true;
  service.status_ = null;
  assert.equal(await hosted.status(true), null);
  await assert.rejects(
    hosted.shareConversation("c-1"),
    /Sharing isn't available/,
  );
  service.status_ = {
    ...status,
    blocked: true,
    conversations: false,
    artifacts: false,
  };
  await hosted.status(true);
  await assert.rejects(
    hosted.publishArtifact(card),
    /turned off sharing for your account/,
  );
  service.status_ = { ...status, artifacts: false };
  await hosted.status(true);
  await assert.rejects(
    hosted.publishArtifact(card),
    /turned off sharing artifacts/,
  );
});

test("signing out forgets the links", async (t) => {
  const { hosted } = setup(t);
  await hosted.publishArtifact(card);
  hosted.close();
  assert.equal(hosted.link(card.identity), undefined);
  assert.deepEqual(hosted.identities(), []);
});

test("unpublishing while a version is being published does not make it public again", async (t) => {
  const { hosted, service, shares, calls } = setup(t);
  await hosted.publishArtifact(card);
  const create = service.create.bind(service);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  service.create = async (body) => {
    await gate;
    return create(body);
  };
  const pending = hosted.publishArtifact({ ...card, content: "<p>2</p>" });
  await wait(10); // The upload has started and waits on the service.
  await hosted.unpublishArtifact(card.identity);
  release();
  await assert.rejects(pending, /public link was stopped/);
  assert.equal(hosted.link(card.identity), undefined);
  assert.deepEqual(hosted.identities(), []);
  assert.equal(shares.length, 0);
  assert.ok(calls.filter((c) => c.startsWith("revoke")).length >= 2);
});

const chat: Conversation = {
  id: "c-inv",
  title: "Plan",
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    {
      id: "t-1",
      prompt: "Hi",
      attachments: [],
      items: [],
      status: "completed",
      createdAt: 1,
    },
  ],
};

test("inviting someone to a chat with no share makes an invited-only share first", async (t) => {
  const { hosted, bodies, calls, shares, conversations, changes } = setup(t);
  conversations.push(chat);
  assert.equal(await hosted.setShareAccess("c-inv", "invited"), null);
  const result = await hosted.inviteToShare("c-inv", "ann@example.com");
  assert.equal(result.added, true);
  assert.equal(result.mailed, true);
  assert.equal(result.share.access, "invited");
  assert.deepEqual(result.share.invites, ["ann@example.com"]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].access, "invited");
  assert.deepEqual(shares[0].invites, ["ann@example.com"]);
  assert.ok(calls.includes("invite 1 ann@example.com"));
  assert.deepEqual(changes.at(-1), ["conversation", "c-inv"]);
  // The same address again: nothing new, no second share.
  const again = await hosted.inviteToShare("c-inv", "ann@example.com");
  assert.equal(again.added, false);
  assert.equal(calls.filter((c) => c.startsWith("create")).length, 1);
});

test("a share moves between the public link and invited people", async (t) => {
  const { hosted, calls, shares, conversations } = setup(t);
  conversations.push(chat);
  const link = await hosted.setShareAccess("c-inv", "link");
  assert.equal(link?.access, undefined, "no share: the link makes one");
  // Nobody is invited yet: switching to invited people only stops the share.
  assert.equal(await hosted.setShareAccess("c-inv", "invited"), null);
  assert.equal(shares.length, 0);
  await hosted.setShareAccess("c-inv", "link");
  await hosted.inviteToShare("c-inv", "ann@example.com");
  const invited = await hosted.setShareAccess("c-inv", "invited");
  assert.equal(invited?.access, "invited");
  assert.ok(calls.some((call) => /^access \d+ invited$/.test(call)));
  // Already there: no call.
  const before = calls.length;
  await hosted.setShareAccess("c-inv", "invited");
  assert.ok(!calls.slice(before).some((c) => c.startsWith("access")));
  assert.equal(
    (await hosted.setShareAccess("c-inv", "link"))?.access,
    undefined,
  );
});

test("the last person leaving an invited-only share stops it; a public share stays", async (t) => {
  const { hosted, shares, calls, conversations } = setup(t);
  conversations.push(chat);
  await hosted.inviteToShare("c-inv", "ann@example.com");
  await hosted.inviteToShare("c-inv", "bo@example.com");
  const left = await hosted.removeShareInvite("c-inv", "ann@example.com");
  assert.deepEqual(left?.invites, ["bo@example.com"]);
  assert.equal(await hosted.removeShareInvite("c-inv", "bo@example.com"), null);
  assert.ok(calls.includes("revoke 1"));
  assert.equal(shares.length, 0);

  // On a public link, nobody left is still a link.
  await hosted.setShareAccess("c-inv", "link");
  await hosted.inviteToShare("c-inv", "cy@example.com");
  const kept = await hosted.removeShareInvite("c-inv", "cy@example.com");
  assert.deepEqual(kept?.invites, []);
  assert.equal(shares.length, 1);
});
