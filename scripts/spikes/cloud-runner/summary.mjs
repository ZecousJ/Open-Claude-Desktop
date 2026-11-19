// Prints a one-screen summary of results/<arch>.json written by probe.mjs.
//   node scripts/spikes/cloud-runner/summary.mjs [results/arm64.json]
import fs from "node:fs";
import path from "node:path";

const file =
  process.argv[2] ?? path.join(import.meta.dirname, "results", "arm64.json");
const r = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(
  `${r.codex} | ${r.bwrap} | ${r.runsc} (${r.runscPlatform}) | ${r.arch} ${r.kernel}`,
);
for (const [kind, l] of Object.entries(r.launchers)) {
  const row = [];
  row.push(
    `start=${l.start?.ok ? `ok ${l.start.ms}ms` : `FAIL ${l.start?.error}`}`,
  );
  if (l.jsonRpc) row.push(`rpc=${l.jsonRpc.ok ? "ok" : "FAIL"}`);
  if (l.memoryIdle)
    row.push(
      `idle=${l.memoryIdle.pssMiB}MiB PSS/${l.memoryIdle.rssMiB}MiB RSS`,
    );
  if (l.memoryNpmInstall)
    row.push(
      `npm-peak=${l.memoryNpmInstall.peak.pssMiB}MiB PSS (installed=${l.memoryNpmInstall.installed})`,
    );
  if (l.codexSandbox) row.push(`codex-sandbox="${l.codexSandbox.verdict}"`);
  if (l.resumeAfterRestore)
    row.push(`resume=${l.resumeAfterRestore.ok ? "ok" : "FAIL"}`);
  if (l.resumeBwrapSnapshotUnderRunsc)
    row.push(
      `resume-bwrap-in-runsc=${l.resumeBwrapSnapshotUnderRunsc.ok ? "ok" : "FAIL"}`,
    );
  if (l.egress)
    row.push(
      "egress=" +
        ["git", "npm", "pip", "blockedHost", "bypassProxy"]
          .map((k) => `${k}:${l.egress[k]?.ok ? "ok" : "FAIL"}`)
          .join(","),
    );
  if (l.error) row.push(`error=${l.error}`);
  console.log(`- ${kind}: ${row.join(" | ")}`);
}
for (const [kind, d] of Object.entries(r.density ?? {}))
  console.log(
    `- density ${kind} x${d.sandboxes}: ` +
      (d.error
        ? `FAIL ${d.error}`
        : `PSS each ${d.pssMiBEach.join("/")} MiB, container +${d.containerDeltaMiB} MiB (${d.containerDeltaMiBPerSandbox} per sandbox)`),
  );
