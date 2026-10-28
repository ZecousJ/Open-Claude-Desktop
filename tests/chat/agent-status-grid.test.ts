import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_AGENT_CELLS,
  agentCells,
  agentGridSummary,
} from "../../src/transcript/agents/AgentStatusGrid";

const agents = (...statuses: string[]) =>
  statuses.map((status) => ({ status }));

test("agent cells group by state and end in a ghost only when more are coming", () => {
  assert.deepEqual(
    agentCells(agents("running", "completed", "errored", "pendingInit")),
    ["done", "running", "error", "pending"],
  );
  assert.deepEqual(agentCells(agents("interrupted"), true), [
    "stopped",
    "ghost",
  ]);
  assert.deepEqual(agentCells([], true), ["ghost"]);
  assert.deepEqual(agentCells([]), []);
});

test("past the cell limit every state keeps a cell and the rest share by size", () => {
  const many = agents(
    ...Array(60).fill("completed"),
    ...Array(30).fill("running"),
    "errored",
  );
  const cells = agentCells(many, true);
  assert.equal(cells.length, MAX_AGENT_CELLS);
  assert.ok(cells.includes("error"));
  assert.equal(cells.at(-1), "ghost");
  const done = cells.filter((cell) => cell === "done").length;
  const running = cells.filter((cell) => cell === "running").length;
  assert.ok(done > running && running > 1);
});

test("the grid's summary counts agents by state", () => {
  assert.equal(
    agentGridSummary(agents("completed", "running", "errored")),
    "1 of 3 agents done, 1 running, 0 stalled, 1 failed",
  );
  assert.equal(agentGridSummary([], true), "Waiting for agents to start");
  assert.equal(agentGridSummary([]), "Waiting for agents to start");
  assert.equal(
    agentGridSummary(agents("interrupted")),
    "0 of 1 agent done, 1 stopped, 0 failed",
  );
  assert.equal(
    agentGridSummary(agents("stalled", "running", "pendingInit")),
    "0 of 3 agents done, 1 running, 1 stalled, 0 failed",
  );
});

test("a stopped agent changes the summary; wrapping cards hold 8 rows of 35", async () => {
  assert.equal(
    agentGridSummary(agents("completed", "interrupted")),
    "1 of 2 agents done, 1 stopped, 0 failed",
  );
  const {
    agentCells: cells,
    WRAP_ROW_CELLS,
    WRAP_MAX_ROWS,
  } = await import("../../src/transcript/agents/AgentStatusGrid");
  assert.equal(
    cells(
      agents(...Array(100).fill("running")),
      false,
      WRAP_ROW_CELLS * WRAP_MAX_ROWS,
    ).length,
    100,
  );
  assert.deepEqual(cells(agents("stalled", "running")), ["running", "stalled"]);
});
