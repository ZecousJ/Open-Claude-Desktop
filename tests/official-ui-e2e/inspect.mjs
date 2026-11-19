#!/usr/bin/env node
/**
 * Evaluates an expression in a running e2e client (E2E_KEEP=1 left it open),
 * with the page helpers loaded: node tests/official-ui-e2e/inspect.mjs '<expr>' [log]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "./harness.mjs";
const [expression, logArg, windowArg] = process.argv.slice(2);
const logs = [];
for (const run of fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("claudex-e2e-")))
  for (const entry of [run, ...fs.readdirSync(path.join(os.tmpdir(), run)).map((w) => path.join(run, w))])
    if (fs.existsSync(path.join(os.tmpdir(), entry, "client.log"))) logs.push(path.join(os.tmpdir(), entry, "client.log"));
const log = (logArg && logArg !== '-' ? logArg : undefined) ?? logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const line = fs.readFileSync(log, "utf8").split("\n").find((l) => l.includes("debug origin"));
const [, origin, cookie] = /debug origin (\S+) cookie (\S+)/.exec(line);
const client = Object.assign(new Client(log), { origin, cookie });
const value = await client.page(windowArg === "checkout" ? "checkout" : Number(windowArg ?? 0)).eval(expression);
console.log(typeof value === "string" ? value : JSON.stringify(value, null, 1));
