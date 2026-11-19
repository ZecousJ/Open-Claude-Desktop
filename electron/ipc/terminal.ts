import { z } from "zod";
import type { TerminalController } from "../terminal/terminal-controller";
import type { AppContext } from "../app/app-context";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
const id = z.string().min(1).max(500);
const dimension = z.custom<number>((value) => typeof value === "number");
const terminalSize = z.strictObject({ rows: dimension, cols: dimension });
const terminalStartOptions = z
  .strictObject({ size: terminalSize, discardOnExit: z.literal(true) })
  .optional();
export function registerTerminalHandlers(
  handle: Handle,
  getController: () => TerminalController,
  ctx?: Pick<AppContext, "allowedFolder" | "engine">,
) {
  handle(
    "officialDraftTerminalStart",
    (rawCwd: unknown, rawShell: unknown, rawSize: unknown) => {
      if (!ctx) throw Error("Draft terminals are unavailable on this host.");
      const cwd = z.string().min(1).max(4096).optional().parse(rawCwd);
      const shell = z.string().min(1).max(1000).optional().parse(rawShell);
      const size = terminalSize.optional().parse(rawSize);
      const folder =
        cwd === "~" ? os.homedir() : (cwd ?? ctx.engine.defaultWorkspace);
      if (
        cwd &&
        cwd !== "~" &&
        path.resolve(cwd) !== path.resolve(ctx.engine.defaultWorkspace)
      ) {
        try {
          ctx.allowedFolder(cwd);
        } catch {
          throw Error(`Choose the working folder with the folder picker: ${cwd}`);
        }
      } else fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (!path.isAbsolute(folder) || !fs.statSync(folder).isDirectory())
        throw Error("Choose an existing local folder.");
      return getController().startDraft(folder, shell, size);
    },
  );
  handle("terminalList", (raw: unknown) => getController().list(id.parse(raw)));
  handle("terminalEnsure", (raw: unknown) =>
    getController().ensure(id.parse(raw)),
  );
  handle("terminalStart", (raw: unknown, shell: unknown, options: unknown) =>
    getController().start(
      id.parse(raw),
      shell === undefined || shell === null
        ? undefined
        : z.string().min(1).max(1000).parse(shell),
      terminalStartOptions.parse(options),
    ),
  );
  handle("terminalShells", (raw: unknown) =>
    getController().shellChoices(id.parse(raw)),
  );
  handle("terminalWrite", (raw: unknown, session: unknown, delta: unknown) =>
    getController().write(
      id.parse(raw),
      id.parse(session),
      z.string().min(1).max(90_000).parse(delta),
    ),
  );
  handle(
    "terminalResize",
    (raw: unknown, session: unknown, requestedRows: unknown, requestedCols: unknown) =>
      getController().resize(
        id.parse(raw),
        id.parse(session),
        dimension.parse(requestedRows),
        dimension.parse(requestedCols),
      ),
  );
  handle("terminalBusy", (raw: unknown) => getController().busy(id.parse(raw)));
  handle("terminalClose", (raw: unknown, session: unknown) =>
    getController().close(id.parse(raw), id.parse(session)),
  );
}
