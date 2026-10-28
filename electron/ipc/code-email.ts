import type { IpcHandle } from "../app/app-context";
import type { CodeEmailStatus } from "../../shared/code-email-api";

/** Desktop and older hosts truthfully report no cloud email channel. */
export function registerCodeEmailHandlers(
  handle: IpcHandle,
  ctx: { codeEmailStatus?(): Promise<CodeEmailStatus> },
) {
  handle(
    "codeEmailStatus",
    () => ctx.codeEmailStatus?.() ?? Promise.resolve({ available: false }),
  );
}
