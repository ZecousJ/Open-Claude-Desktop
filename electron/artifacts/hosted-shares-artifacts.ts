import type {
  ArtifactPublication,
  ArtifactSharingState,
  ShareAccess,
  SharingStatus,
} from "../../shared/sharing-api";
import { shareExpired } from "../../shared/sharing";
import type { ArtifactShareInput } from "../../shared/types";
import { buildArtifactSnapshot } from "../conversations/conversation-snapshot";
import {
  previouslyUnpublishedMessage,
  takenDownMessage,
  maxSources,
  digestOf,
  versionOf,
  versionKeyOf,
  sharingKeyOf,
  sharingStopKey,
} from "./hosted-shares-support";
import type { HostedShares } from "./hosted-shares";

// ---- artifacts  Each version published gets a public link of its own that
// keeps that version (it does not follow later changes), and Unpublish removes
// the link of every version. A version is its content: the service sees a hash
// of the artifact identity and of the version, never either one.

/** The links this computer knows of one artifact (active or taken down). */
export function artifactShares(
  this: HostedShares,
  identity: string,
  sharing = false,
) {
  return (this.listCache?.shares ?? []).filter((share) => {
    if (share.kind !== "artifact" || shareExpired(share, this.now()))
      return false;
    const known = this.sources.get(share.sourceKey);
    return (
      known?.kind === "artifact" &&
      known.source === identity &&
      !!known.sharing === sharing
    );
  });
}

/**
 * The version's link. A link made before versions were published on
 * their own (keyed by the identity alone) counts for the version it last
 * uploaded.
 */
export function versionShare(
  this: HostedShares,
  input: ArtifactShareInput,
  limits: Pick<SharingStatus, "maxArtifactBytes" | "maxSnapshotBytes">,
) {
  const key = versionKeyOf(input);
  const own = this.listCache?.shares.find(
    (share) =>
      share.kind === "artifact" &&
      share.sourceKey === key &&
      !shareExpired(share, this.now()),
  );
  if (own) return own;
  const legacy = this.cachedFor("artifact", input.identity);
  const digest = legacy && this.sources.get(legacy.sourceKey)?.digest;
  if (!digest) return undefined;
  try {
    return digestOf(buildArtifactSnapshot(input, limits)) === digest
      ? legacy
      : undefined;
  } catch {
    return undefined; // Too large to have been published.
  }
}

/** What the service has of this version; null without hosted sharing. */
export async function publication(
  this: HostedShares,
  input: ArtifactShareInput,
): Promise<ArtifactPublication | null> {
  const status = await this.status();
  if (!status) return null;
  await this.list("artifact");
  const share = this.versionShare(input, status);
  return {
    share: share ? this.present(share) : null,
    liveLinks: this.artifactShares(input.identity).filter(
      (item) => item.status === "active",
    ).length,
    unpublished: !share && this.unpublished.has(versionKeyOf(input)),
  };
}

/** Publishes this version at a link of its own; a published version answers its link. */
export async function publishArtifact(
  this: HostedShares,
  input: ArtifactShareInput,
) {
  const status = await this.allowed("artifact");
  await this.list("artifact");
  const existing = this.versionShare(input, status);
  if (existing?.status === "active") return this.present(existing);
  if (existing) throw new Error(takenDownMessage);
  if (this.unpublished.has(versionKeyOf(input)))
    throw new Error(previouslyUnpublishedMessage);
  const share = await this.upload(input, status);
  this.options.changed("artifact", input.identity);
  return this.present(share);
}

export async function artifactShareState(
  this: HostedShares,
  input: ArtifactShareInput,
): Promise<ArtifactSharingState> {
  await this.list("artifact");
  const shares = this.artifactShares(input.identity, true);
  const latest = shares.find(
    (share) => share.sourceKey === sharingKeyOf(input.identity),
  );
  return {
    share: latest ? this.present(latest) : null,
    versions: shares
      .flatMap((share) => {
        const version = this.sources.get(share.sourceKey)?.version;
        return version && share.status === "active"
          ? [{ version, share: this.present(share) }]
          : [];
      })
      .sort(
        (first, second) =>
          first.share.createdAt - second.share.createdAt ||
          [...this.sources.keys()].indexOf(
            sharingKeyOf(input.identity, first.version),
          ) -
            [...this.sources.keys()].indexOf(
              sharingKeyOf(input.identity, second.version),
            ),
      ),
    currentVersion: versionOf(input),
    autoUpdate: this.autoArtifacts.has(input.identity),
  };
}

/**
 * Version links stay fixed; the latest link follows explicit/automatic shares.
 */
export async function shareArtifact(
  this: HostedShares,
  input: ArtifactShareInput,
  autoUpdate: boolean,
  access?: ShareAccess,
) {
  const previous =
    this.artifactUpdates.get(input.identity) ?? Promise.resolve();
  const stopKey = sharingStopKey(input.identity);
  const stops = this.stops.get(stopKey) ?? 0;
  const revision = this.autoRevisions.get(input.identity) ?? 0;
  const update = previous
    .catch(() => {})
    .then(async () => {
      if (this.closed || (this.stops.get(stopKey) ?? 0) !== stops)
        throw new Error("The artifact's public link was stopped.");
      const status = await this.allowed("artifact");
      await this.list("artifact");
      const existing = this.artifactShares(input.identity, true).find(
        (share) =>
          share.sourceKey === sharingKeyOf(input.identity, versionOf(input)),
      );
      const audience =
        access ??
        this.artifactShares(input.identity, true).find(
          (share) => share.sourceKey === sharingKeyOf(input.identity),
        )?.access ??
        "link";
      if (existing?.status === "disabled") throw new Error(takenDownMessage);
      if (!existing) await this.upload(input, status, true, audience);
      const snapshot = buildArtifactSnapshot(input, status);
      const key = sharingKeyOf(input.identity);
      const share = await this.options.service.create({
        kind: "artifact",
        source_key: key,
        title: snapshot.title,
        snapshot,
        ...(audience === "invited" ? { access: audience } : {}),
      });
      if (this.closed || (this.stops.get(stopKey) ?? 0) !== stops) {
        await this.options.service.revoke(share.id).catch(() => {});
        throw new Error("The artifact's public link was stopped.");
      }
      this.remember(key, {
        kind: "artifact",
        source: input.identity,
        digest: digestOf(snapshot),
        sharing: true,
      });
      this.store(share);
      if ((this.autoRevisions.get(input.identity) ?? 0) === revision) {
        if (autoUpdate) this.autoArtifacts.add(input.identity);
        else this.autoArtifacts.delete(input.identity);
      }
      this.save();
      this.options.changed("artifact", input.identity);
    });
  this.artifactUpdates.set(input.identity, update);
  try {
    await update;
  } finally {
    if (this.artifactUpdates.get(input.identity) === update)
      this.artifactUpdates.delete(input.identity);
  }
  return this.artifactShareState(input);
}

export async function setArtifactShareAccess(
  this: HostedShares,
  input: ArtifactShareInput,
  access: ShareAccess,
) {
  const previous =
    this.artifactUpdates.get(input.identity) ?? Promise.resolve();
  let create = false;
  const update = previous
    .catch(() => {})
    .then(async () => {
      await this.allowed("artifact");
      await this.list("artifact", true);
      const shares = this.artifactShares(input.identity, true);
      create = shares.length === 0;
      for (const share of shares) {
        const updated = await this.options.service.setAccess(share.id, access);
        this.store(updated);
      }
      this.options.changed("artifact", input.identity);
    });
  this.artifactUpdates.set(input.identity, update);
  try {
    await update;
  } finally {
    if (this.artifactUpdates.get(input.identity) === update)
      this.artifactUpdates.delete(input.identity);
  }
  if (create) return this.shareArtifact(input, false, access);
  return this.artifactShareState(input);
}

export async function setArtifactAutoShare(
  this: HostedShares,
  input: ArtifactShareInput,
  enabled: boolean,
) {
  if (enabled) return this.shareArtifact(input, true);
  this.autoRevisions.set(
    input.identity,
    (this.autoRevisions.get(input.identity) ?? 0) + 1,
  );
  this.autoArtifacts.delete(input.identity);
  this.save();
  this.options.changed("artifact", input.identity);
  return this.artifactShareState(input);
}

export async function syncAutoArtifact(
  this: HostedShares,
  input: ArtifactShareInput,
) {
  await this.artifactUpdates.get(input.identity)?.catch(() => {});
  if (!this.autoArtifacts.has(input.identity) || this.closed) return;
  const known = this.sources.get(sharingKeyOf(input.identity));
  const status = await this.allowed("artifact");
  if (known?.digest === digestOf(buildArtifactSnapshot(input, status))) return;
  await this.shareArtifact(input, true);
}

export async function unshareArtifact(this: HostedShares, identity: string) {
  this.autoArtifacts.delete(identity);
  const stopKey = sharingStopKey(identity);
  this.stops.set(stopKey, (this.stops.get(stopKey) ?? 0) + 1);
  this.save();
  await this.artifactUpdates.get(identity)?.catch(() => {});
  await this.list("artifact", true);
  for (const share of this.artifactShares(identity, true)) {
    await this.options.service.revoke(share.id);
    this.forget(share.id);
    this.sources.delete(share.sourceKey);
  }
  this.save();
  this.options.changed("artifact", identity);
}

export async function upload(
  this: HostedShares,
  input: ArtifactShareInput,
  limits: Pick<SharingStatus, "maxArtifactBytes" | "maxSnapshotBytes">,
  sharing = false,
  access: ShareAccess = "link",
) {
  const snapshot = buildArtifactSnapshot(input, limits);
  const key = sharing
    ? sharingKeyOf(input.identity, versionOf(input))
    : versionKeyOf(input);
  const stopKey = sharing ? sharingStopKey(input.identity) : input.identity;
  const stops = this.stops.get(stopKey) ?? 0;
  const share = await this.options.service.create({
    kind: "artifact",
    source_key: key,
    title: snapshot.title,
    snapshot,
    ...(access === "invited" ? { access } : {}),
  });
  if ((this.stops.get(stopKey) ?? 0) !== stops || this.closed) {
    // The artifact was unpublished (or the account signed out) while this
    // upload was on its way: it must not make the artifact public again.
    await this.options.service.revoke(share.id).catch(() => {});
    throw new Error("The artifact's public link was stopped.");
  }
  this.remember(key, {
    kind: "artifact",
    source: input.identity,
    version: versionOf(input),
    ...(sharing ? { sharing: true } : {}),
  });
  this.store(share);
  return share;
}

/**
 * Unpublish: every version's link stops, and those versions can't be
 * published again (the reference's "previously unpublished").
 */
export async function unpublishArtifact(this: HostedShares, identity: string) {
  this.stops.set(identity, (this.stops.get(identity) ?? 0) + 1);
  await this.list("artifact", true);
  for (const share of this.artifactShares(identity)) {
    await this.options.service.revoke(share.id);
    this.forget(share.id);
    if (this.sources.get(share.sourceKey)?.version)
      this.markUnpublished(share.sourceKey);
    this.sources.delete(share.sourceKey);
  }
  this.save();
  this.options.changed("artifact", identity);
}

export function markUnpublished(this: HostedShares, key: string) {
  this.unpublished.delete(key);
  this.unpublished.add(key);
  while (this.unpublished.size > maxSources)
    this.unpublished.delete(this.unpublished.values().next().value!);
}
