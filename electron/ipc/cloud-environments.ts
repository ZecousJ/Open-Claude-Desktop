import type { AppContext, IpcHandle } from "../app/app-context";
import { CloudEnvironments } from "../cloud/environments";
import { cloudEnvironmentId } from "../../shared/cloud-environments-input";

export function registerCloudEnvironmentHandlers(
  handle: IpcHandle,
  ctx: Pick<AppContext, "store">,
) {
  const profiles = () => new CloudEnvironments(ctx.store.root);
  handle("listCloudEnvironments", async () => profiles().list());
  handle("saveCloudEnvironment", async (input: unknown) =>
    profiles().save(input),
  );
  handle("archiveCloudEnvironment", async (id: unknown) =>
    profiles().archive(cloudEnvironmentId.parse(id)),
  );
}
