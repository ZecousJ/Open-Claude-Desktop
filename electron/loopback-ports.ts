import type { Server, AddressInfo } from "node:net";

// Account UI origins must remain stable for their browser storage. Services
// choosing a random port must leave those saved ports available during startup.
const reservedPorts = new Set<number>();
export function reserveLoopbackPort(port: number) {
  reservedPorts.add(port);
}
export function isReservedLoopbackPort(port: number) {
  return reservedPorts.has(port);
}

export async function listenOnLoopback(server: Server, port = 0): Promise<number> {
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.off("listening", ready);
        reject(error);
      };
      const ready = () => {
        server.off("error", failed);
        resolve();
      };
      server.once("error", failed);
      server.once("listening", ready);
      server.listen(port, "127.0.0.1");
    });
    const selected = (server.address() as AddressInfo).port;
    if (port !== 0 || !reservedPorts.has(selected)) return selected;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
}
