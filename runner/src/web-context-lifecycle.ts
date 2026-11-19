import { discardIncognitoUploads } from "../../electron/workspace/incognito-upload";
import type { EnvironmentRef } from "../../shared/types";
import { webHost } from "../../shared/host";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { inCodeWorkspace } from "./code-workspace";
import { pruneIdleSpaceCaches } from "../../electron/engine/codex-cache";
import { Me } from "./web-app-support";
import type { WebAppContext } from "./web-app-context";
import { closeOfficialCodeTerminals } from "./official-code-terminals";

export async function codeEmailStatus(this: WebAppContext) {
  if (
    !(this.runtime.host ?? webHost).capabilities.cloudCode ||
    this.closed ||
    this.signedOut
  )
    return { available: false };
  return this.codeMail.status();
}

export async function me(
  this: WebAppContext,
  accessToken: string,
): Promise<Me> {
  const client = new Sub2ApiClient(this.runtime.serviceUrl, this.runtime.fetch);
  const user = await client.me(accessToken);
  return { id: user.id, email: user.email, username: user.username };
}

// ---- AppContext

export function allowedFolder(
  this: WebAppContext,
  folder?: string,
  _environment?: EnvironmentRef,
) {
  // Only the runner names a folder: a Code session's own, in the shared
  // workspace or in its space (the browser's `cwd` never gets this far,
  // method-guard.ts).
  if (
    folder &&
    !inCodeWorkspace(this.workspace, folder) &&
    !this.inSpaceWorkspace(folder)
  )
    throw new Error("Folders on the server can't be used from the web.");
}

export function reclaimCaches(this: WebAppContext) {
  if (!this.store) return;
  const now = Date.now();
  if (now - this.lastCacheCheck < 60_000) return;
  this.lastCacheCheck = now;
  try {
    if (!this.runtime.cachePressure?.(this.store.root)) return;
  } catch (error) {
    this.log(`claudex: cache pressure check failed: ${String(error)}`);
    return;
  }
  pruneIdleSpaceCaches(this.store.root, this.activeSpaces);
}

/**
 * Closes the context: packages' account services, the engine, the store
 * (waiting for its writes) and the user's key and previews.
 */
export async function close(this: WebAppContext) {
  if (this.closedFlag) return;
  this.closedFlag = true;
  await closeOfficialCodeTerminals(this);
  this.codeEmails.stop();
  this.deviceController?.dispose();
  this.connectorOAuth?.close();
  if (this.activeAccount) await this.deactivatingListeners.emitAsync();
  if (this.remote) this.remote.ready = false;
  this.usageTurns.clear();
  this.scheduler?.stop();
  await this.scheduler?.settle();
  try {
    await this.engine?.stop();
    if (this.store) discardIncognitoUploads(this.store.root, this.selectedAttachments);
  } catch (error) {
    this.log(`Could not retire temporary Chat attachments: ${error instanceof Error ? error.message : String(error)}`);
  }
  await this.store?.close().catch(() => {});
  this.artifactPreviews.clear();
  this.selectedAttachments.clear();
  await this.remote?.release(this.credentials).catch(() => {});
  this.credentials?.clear();
  this.session?.end();
  this.policyHost?.stop();
  this.policyHost = undefined;
  this.activeAccount = undefined;
  this.rendererBase = undefined;
  this.runtime.closed?.(this);
}
