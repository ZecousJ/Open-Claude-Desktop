import { createHash } from "node:crypto";
import { z } from "zod";
import { checkedOrganizationCatalog } from "../../shared/official-organization-catalog";
import { pluginArchiveLimit } from "../../shared/plugin-upload";
import type { Sub2ApiClient } from "../sub2api/client";
import type { RemoteSession } from "../sub2api/session";
import { Sub2ApiError } from "../sub2api/http";
import { assertAccountOperationCurrent } from "../account/operation-lease";

const idSchema = z.string().regex(/^plugin_[a-f0-9]{24}$/);
const grantSchema = z.object({
  id: idSchema,
  organization_id: z.guid(),
  marketplace_id: z.guid(),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  display_name: z.string().min(1).max(200),
  description: z.string().max(1000),
  version: z.string().max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  installation_preference: z.enum(["available", "auto_install", "required"]),
});

export type OrganizationPluginGrant = z.infer<typeof grantSchema>;

export class OrganizationPluginPackages {
  constructor(
    private client: Pick<Sub2ApiClient, "api" | "call" | "fetchImpl">,
    private session: Pick<RemoteSession, "authorized">,
    private current: () => boolean,
  ) {}

  async catalog() {
    assertAccountOperationCurrent(this.current);
    const result = await this.session.authorized(
      (token) => this.client.call("/claudex/plugin-organization-catalog", { token }),
      this.current,
    );
    assertAccountOperationCurrent(this.current);
    return checkedOrganizationCatalog(result);
  }

  async authorize(id: string): Promise<OrganizationPluginGrant> {
    const route = "/claudex/plugin-organization-catalog/" + idSchema.parse(id) + "/authorization";
    assertAccountOperationCurrent(this.current);
    const result = await this.session.authorized(
      (token) => this.client.call(route, { token }),
      this.current,
    );
    assertAccountOperationCurrent(this.current);
    const grant = grantSchema.parse(result);
    if (grant.id !== id)
      throw Error("The authorized plugin identity changed.");
    return grant;
  }

  async archive(grant: OrganizationPluginGrant): Promise<Buffer> {
    const { id, sha256 } = grantSchema.parse(grant);
    const route = "/claudex/plugin-organization-catalog/" + id + "/packages/" + sha256;
    assertAccountOperationCurrent(this.current);
    const bytes = await this.session.authorized(async (token) => {
      const response = await this.client.fetchImpl(this.client.api(route), {
        headers: { Authorization: "Bearer " + token, Accept: "application/zip" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok || !response.body || response.headers.get("content-type") !== "application/zip") {
        await response.body?.cancel();
        throw new Sub2ApiError(response.status, "ORGANIZATION_PLUGIN_PACKAGE_UNAVAILABLE", "The approved plugin package is unavailable.");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          assertAccountOperationCurrent(this.current);
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > pluginArchiveLimit) throw Error("The approved plugin package is too large.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    }, this.current);
    assertAccountOperationCurrent(this.current);
    if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw Error("The approved plugin package checksum did not match.");
    return bytes;
  }
}
