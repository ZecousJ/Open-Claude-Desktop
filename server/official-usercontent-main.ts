import { startOfficialUserContentServer } from "./official-usercontent";

const root = process.env.CLAUDEX_USERCONTENT_ROOT;
const parentOrigin = process.env.CLAUDEX_USERCONTENT_PARENT_ORIGIN;
const publicOrigin = process.env.CLAUDEX_USERCONTENT_ORIGIN;
const port = Number(process.env.CLAUDEX_USERCONTENT_PORT ?? "4350");
if (
  !root ||
  !parentOrigin ||
  !publicOrigin ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw Error(
    "Set the preview root, parent origin, separate public origin and valid listener port.",
  );
const server = await startOfficialUserContentServer({
  root,
  parentOrigin,
  publicOrigin,
  port,
  host: process.env.CLAUDEX_USERCONTENT_HOST ?? "127.0.0.1",
  documentRuntime: process.env.CLAUDEX_USERCONTENT_DOCUMENT_RUNTIME,
});
console.log(`Official user-content resources listening for ${server.origin}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void server.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
