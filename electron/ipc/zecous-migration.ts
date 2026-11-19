import {
  confirmOfficialZecousMigration,
  noZecousMigration,
  officialZecousMigrationFrom,
  refreshZecousMigrationReadiness,
  zecousMigrationFrom,
  zecousMigrationRoute,
  type ZecousMigration,
  type ZecousMigrationRoute,
} from "../../shared/zecous-migration-api";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import type { AppContext, IpcHandle } from "../app/app-context";
import { refreshAccountState } from "./usage";

/**
 * The move from ZecousAI (shared/zecous-migration-api.ts), read and confirmed
 * with the session's token in the main process. A service without the
 * component, or an account that isn't signed in, has nothing to move.
 */
export function registerZecousMigrationHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const operation = () => {
    const remote = ctx.remote;
    if (!remote?.ready || ctx.accountRetiring)
      throw Error("Sign in to Claudex first.");
    const { accounts, session } = remote;
    const activation = ctx.accountActivationIdentity;
    const current = () =>
      ctx.remote === remote &&
      remote.ready &&
      remote.session === session &&
      ctx.accountActivationIdentity === activation &&
      !ctx.accountRetiring;
    const check = () => assertAccountOperationCurrent(current);
    const request = async (
      route: ZecousMigrationRoute = zecousMigrationRoute,
    ) => {
      const result = await session.authorized((token) => {
        check();
        return route !== zecousMigrationRoute
          ? accounts.client.call(route, {
              method: "POST",
              body: {},
              token,
            })
          : accounts.client.call(route, { token });
      }, current);
      check();
      return result;
    };
    const refresh = async () => {
      check();
      await refreshZecousMigrationReadiness(() => refreshAccountState(ctx));
      check();
    };
    return { request, refresh };
  };

  handle("zecousMigration", async (): Promise<ZecousMigration> => {
    try {
      return zecousMigrationFrom(await operation().request());
    } catch {
      return noZecousMigration;
    }
  });
  handle("confirmZecousMigration", async () =>
    zecousMigrationFrom(
      await operation().request(`${zecousMigrationRoute}/confirm`),
    ),
  );
  handle("officialZecousMigration", async (refreshOnDone: unknown) => {
    const { request, refresh } = operation();
    const status = officialZecousMigrationFrom(await request());
    if (refreshOnDone === true && status.state === "done") await refresh();
    return status;
  });
  handle("officialConfirmZecousMigration", async () => {
    const { request, refresh } = operation();
    const result = await confirmOfficialZecousMigration(request);
    await refresh();
    return result;
  });
}
