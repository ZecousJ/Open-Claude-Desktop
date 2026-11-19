#!/usr/bin/env node
/**
 * Runs the official-interface end-to-end cases, in parallel.
 *   node tests/official-ui-e2e/run.mjs              every area
 *   node tests/official-ui-e2e/run.mjs chat files   only these areas
 *   E2E_ONLY="retry" …                              cases whose name matches (plus their group's setup)
 *   E2E_WORKERS=2 …                                 windows side by side (default 2; more is unstable)
 *   E2E_KEEP=1 …                                    leave the client running (one worker)
 *
 * Cases of one group share state and run in order in one window; groups run
 * on a pool of windows of a single client (one account session). A case's
 * group is its `group` field, else the case alone. Conversations a group
 * made (state.created) are deleted after it. Writes a JSON and Markdown
 * report and exits non-zero when a case fails or the adapter logged a gap.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const areas = process.argv.slice(2);
const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, "i") : null;
const keep = !!process.env.E2E_KEEP;
const workers = Math.max(1, Number(process.env.E2E_WORKERS ?? (keep ? 1 : 2)));
const groups = new Map();
for (const file of fs.readdirSync(path.join(here, "cases")).filter((f) => f.endsWith(".mjs")).sort()) {
  const area = file.replace(/\.mjs$/, "");
  if (areas.length && !areas.includes(area)) continue;
  const mod = await import(path.join(here, "cases", file));
  for (const c of mod.cases) {
    const key = `${area}:${c.group ?? c.name}`;
    if (!groups.has(key)) groups.set(key, { key, area, cases: [], cleanup: mod.cleanup });
    groups.get(key).cases.push({ area, ...c });
  }
}
// A group runs when one of its cases is selected; its setup cases (`setup: true`) run with it.
const queue = [...groups.values()]
  .filter((g) => !only || g.cases.some((c) => only.test(c.name)))
  .map((g) => ({ ...g, cases: g.cases.filter((c) => !only || only.test(c.name) || c.setup) }));
if (!queue.length) { console.error("No cases selected."); process.exit(2); }

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-e2e-run-"));
const results = [];
const started = Date.now();
const client = await Client.launch({ logDir: runDir }).catch((error) => {
  console.error(error.message);
  process.exit(2);
});
console.log(`client log: ${client.logFile}`);
const runMark = client.logMark();
const parallel = Math.min(workers, queue.length);
async function worker(index) {
  // Worker 0 drives the main window; the others open their own.
  const page = index === 0 ? client.page(0) : await client.openPage();
  for (let group = queue.shift(); group; group = queue.shift()) {
    const state = {};
    for (const c of group.cases) {
      const t0 = Date.now();
      const mark = client.logMark();
      let error = null;
      try {
        await c.run(page, state);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      // One worker: gaps are this case's. Several: the log is shared, gaps are reported for the run.
      const gaps = parallel > 1 || c.allowGaps ? [] : client.gapsSince(mark).filter((l) => !(c.ignoreGaps ?? []).some((re) => re.test(l)));
      const ok = !error && !gaps.length;
      results.push({ area: c.area, group: group.key, name: c.name, ok, error, gaps, ms: Date.now() - t0, worker: index });
      console.log(`${ok ? "PASS" : "FAIL"}  [w${index}] ${c.area} › ${c.name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (error) console.log(`      ${error}`);
      for (const g of gaps.slice(0, 5)) console.log(`      gap: ${g.slice(0, 200)}`);
      if (!ok && c.setup) break;
    }
    if (group.cleanup && !keep) await group.cleanup(page, state).catch((e) => console.log(`      cleanup: ${e.message}`));
    if (state.created?.length)
      await page.api("/api/organizations/x/chat_conversations/delete_many", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_uuids: state.created }),
      }).catch(() => {});
  }
}
await Promise.all(Array.from({ length: parallel }, (_, i) => worker(i)));
// With several windows the adapter's gaps are counted for the whole run.
if (parallel > 1) {
  const gaps = [...new Set(client.gapsSince(runMark).map((l) => l.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id")))];
  if (gaps.length) results.push({ area: "run", group: "run:gaps", name: "no adapter gaps during the run", ok: false, error: `${gaps.length} distinct gaps`, gaps, ms: 0, worker: -1 });
  for (const g of gaps.slice(0, 20)) console.log(`gap: ${g.slice(0, 220)}`);
}
if (!keep) await client.stop();
const order = new Map([...groups.keys(), "run:gaps"].map((k, i) => [k, i]));
results.sort((a, b) => order.get(a.group) - order.get(b.group));
fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(results, null, 2));
const md = [
  `# Official-interface e2e (${new Date().toISOString()}, ${((Date.now() - started) / 1000).toFixed(0)} s, ${workers} clients)`,
  "",
  "| Area | Case | Result | Seconds | Detail |",
  "| --- | --- | --- | --- | --- |",
  ...results.map((r) => `| ${r.area} | ${r.name} | ${r.ok ? "pass" : "**fail**"} | ${(r.ms / 1000).toFixed(1)} | ${(r.error ?? r.gaps[0] ?? "").replace(/\|/g, "\\|").slice(0, 160)} |`),
].join("\n");
fs.writeFileSync(path.join(runDir, "report.md"), md + "\n");
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed in ${((Date.now() - started) / 1000).toFixed(0)} s; report: ${path.join(runDir, "report.md")}`);
process.exit(failed || !results.length ? 1 : 0);
