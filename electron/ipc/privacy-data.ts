import type { AppContext, IpcHandle } from "../app/app-context";
import { PrivacyDataService } from "../account/privacy-data";
import {
  deleteOwnedUpload,
  readOwnedUploadInventory,
} from "../account/privacy-data-uploads";

/** One service per authenticated execution host. Retire before account shutdown
 * awaits anything, including when the same account is subsequently reopened. */
export function registerPrivacyDataHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  let generation = {};
  let retired = false;
  let snapshot: unknown[] = [];
  let lease = {};
  ctx.onAccountDeactivating(() => {
    retired = true;
    generation = {};
  });
  ctx.onAccountActivated(() => {
    retired = false;
    generation = {};
  });
  const owner = () => {
    if (retired || !ctx.activeAccount)
      throw Error("Sign in again to manage your privacy data.");
    const current = [
      generation,
      ctx.activeAccount,
      ctx.store,
      ctx.engine,
      ctx.remote,
    ];
    if (current.some((value, index) => snapshot[index] !== value)) {
      snapshot = current;
      lease = {};
    }
    return lease;
  };
  const service = new PrivacyDataService({
    owner,
    feedback: () => {
      const remote = ctx.remote;
      if (!remote) return undefined;
      if (!remote.ready) throw Error("Sign in again to manage your feedback.");
      const backend = remote.backend;
      return {
        request: (method, route) =>
          backend.session.authorized((token) =>
            backend.client.privacyFeedback(token, method, route),
          ),
      };
    },
    readUploads: () => {
      const store = ctx.store;
      return readOwnedUploadInventory(store.root, store.conversations);
    },
    deleteUpload: (id) => {
      const store = ctx.store;
      return deleteOwnedUpload(store.root, store.conversations, id);
    },
  });
  handle("privacyDataStatus", () => service.privacyDataStatus());
  handle("feedbackHistory", (input) => service.feedbackHistory(input));
  handle("withdrawFeedback", (id) => service.withdrawFeedback(id));
  handle("uploadedFiles", (input) => service.uploadedFiles(input));
  handle("deleteUploadedFile", (id) => service.deleteUploadedFile(id));
}
