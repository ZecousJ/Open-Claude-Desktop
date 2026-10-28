import { z } from "zod";
import type { TerminalController } from "../terminal/terminal-controller";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
const id = z.string().min(1).max(500);
export function registerTerminalHandlers(
  handle: Handle,
  getController: () => TerminalController,
) {
  handle("terminalList", (raw: unknown) => getController().list(id.parse(raw)));
  handle("terminalEnsure", (raw: unknown) =>
    getController().ensure(id.parse(raw)),
  );
  handle("terminalStart", (raw: unknown, shell: unknown) =>
    getController().start(
      id.parse(raw),
      shell === undefined || shell === null
        ? undefined
        : z.string().min(1).max(1000).parse(shell),
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
    (raw: unknown, session: unknown, rows: unknown, cols: unknown) =>
      getController().resize(
        id.parse(raw),
        id.parse(session),
        z.number().int().min(4).max(200).parse(rows),
        z.number().int().min(10).max(300).parse(cols),
      ),
  );
  handle("terminalBusy", (raw: unknown) => getController().busy(id.parse(raw)));
  handle("terminalClose", (raw: unknown, session: unknown) =>
    getController().close(id.parse(raw), id.parse(session)),
  );
}
