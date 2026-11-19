// Runs inside the sandbox. The sandbox has its own network namespace with
// only loopback, so every way out is a Unix socket the runner binds in:
//   node bridge.mjs <port>=<socket> [...] --ready <file>
// listens on 127.0.0.1:<port> and pipes each connection to <socket>.
// The runner side of each socket is the model gateway or the egress proxy.
import fs from "node:fs";
import net from "node:net";

const args = process.argv.slice(2);
const readyIndex = args.indexOf("--ready");
const ready = readyIndex >= 0 ? args[readyIndex + 1] : undefined;
const pairs = args
  .filter((a, i) => a.includes("=") && i !== readyIndex + 1)
  .map((a) => {
    const [port, socket] = a.split("=");
    return { port: Number(port), socket };
  });

let pending = pairs.length;
for (const { port, socket } of pairs) {
  net
    .createServer((client) => {
      const upstream = net.connect(socket);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
    })
    .listen(port, "127.0.0.1", () => {
      if (--pending === 0 && ready) fs.writeFileSync(ready, "ok");
    });
}
