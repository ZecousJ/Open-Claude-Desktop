import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client, profile, sleep } from "./harness.mjs";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-local-mcp-"));
const name = "e2e_local_catalog_" + Date.now(),
  fixture = path.join(temp, "server.mjs");
const definition = {
  name: "local_catalog_probe",
  description: "LOCAL_CATALOG_EXACT_DESCRIPTION",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  _meta: { "claudex/test": "local-catalog" },
};
const code = [
  'import readline from "node:readline";',
  "const tool=" + JSON.stringify(definition) + ";",
  'readline.createInterface({input:process.stdin}).on("line",line=>{let q;try{q=JSON.parse(line)}catch{return}if(q.id===undefined)return;let result;if(q.method==="initialize")result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"Claudex catalog fixture",version:"1.0"}};else if(q.method==="tools/list")result={tools:[tool]};else if(q.method==="tools/call")result={content:[{type:"text",text:"LOCAL_CATALOG_RESULT"}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:q.id,result})+String.fromCharCode(10));});',
].join(String.fromCharCode(10));
await fs.writeFile(fixture, code);
let client, configPath;
const invoke = async (method, args = []) => {
  const r = await fetch(client.origin + "/__debug/call", {
    method: "POST",
    headers: { Cookie: client.cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: method, args }),
  });
  const result = await r.json();
  if (result.error) throw Error(result.error);
  return result.value;
};
try {
  client = await Client.launch();
  const page = client.page(0);
  let inventory;
  for (let attempt = 0; attempt < 30 && !inventory; attempt++) {
    inventory = await invoke("mcpServers").catch(() => undefined);
    if (!inventory) await sleep(200);
  }
  assert.ok(
    inventory,
    "MCP inventory becomes available after account activation",
  );
  configPath = inventory.configPath;
  assert.ok(
    configPath &&
      path.resolve(configPath).startsWith(path.resolve(profile) + path.sep),
  );
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.mcpServers[name], undefined);
  config.mcpServers[name] = { command: process.execPath, args: [fixture] };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const until = Date.now() + 60000;
  let ready;
  while (Date.now() < until) {
    const state = await invoke("mcpServers").catch(() => null);
    ready = state?.servers?.find(
      (s) => s.name === name && s.state === "ready" && s.tools === 1,
    );
    if (ready) break;
    await sleep(400);
  }
  assert.ok(
    ready,
    "Real local MCP process must connect and advertise its tool",
  );
  for (const domain of ["LocalSessions", "LocalAgentModeSessions"]) {
    const list = await page.eval(
      'window["claude.web"][' +
        JSON.stringify(domain) +
        "].getLocalMcpServers()",
    );
    const entry = list.find((s) => s.name === name);
    assert.ok(entry, domain + " must list actual local connector");
    assert.equal(entry.serverSource, "user_config");
    assert.deepEqual(entry.tools, [definition]);
  }
  console.log(
    "Code and Cowork return the real local MCP definition with exact schema, annotations and metadata.",
  );
  const acknowledged = await invoke("setConnectorToolPermission", [
    name,
    definition.name,
    "block",
  ]);
  assert.equal(
    acknowledged.servers
      .find((s) => s.name === name)
      ?.toolList?.find((t) => t.name === definition.name)?.enabled,
    false,
  );
  const blockUntil = Date.now() + 30000;
  let applied = false;
  while (Date.now() < blockUntil) {
    const state = await invoke("mcpServers").catch(() => null);
    const row = state?.servers?.find((s) => s.name === name);
    if (
      row?.toolList?.some(
        (t) => t.name === definition.name && t.enabled === false,
      )
    ) {
      applied = true;
      break;
    }
    await sleep(300);
  }
  assert.ok(applied, "Blocked tool configuration must be actually loaded");
  await page.waitFor(
    'window["claude.web"].LocalAgentModeSessions.getLocalMcpServers().then(rows=>!rows.find(s=>s.name===' +
      JSON.stringify(name) +
      ")?.tools.some(t=>t.name===" +
      JSON.stringify(definition.name) +
      "))",
    30000,
    400,
  );
  console.log(
    JSON.stringify({
      result: "passed",
      completedAt: new Date().toISOString(),
      scope:
        "real local stdio MCP discovered by bundled engine; Code and Cowork official native lists return exact schema/annotations/meta; blocked tool disappears; no model request",
    }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (configPath) {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (config.mcpServers?.[name]) {
      delete config.mcpServers[name];
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    }
    if (client) {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const state = await invoke("mcpServers").catch(() => null);
        if (state && !state.servers.some((s) => s.name === name)) break;
        await sleep(200);
      }
    }
  }
  if (client) {
    console.log("Client evidence: " + client.logFile);
    await client.stop();
  }
  await fs.rm(temp, { recursive: true, force: true });
}
