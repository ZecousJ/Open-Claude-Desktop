import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseline = { H: 47, P: 55, N: 47, C: 12, F: 1, D: 1 };
const baselineSize = Object.values(baseline).reduce((sum, n) => sum + n, 0);
const present = value => typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) && value.length > 0;
const count = (items, field) => items.reduce((out, row) => { out[row[field]] = (out[row[field]] ?? 0) + 1; return out; }, {});
const matrixPath = 'docs/handoff/cloud-frontend-batch-20261103/item-matrix.json';
const assignmentsPath = 'docs/handoff/cloud-frontend-batch-20261103/shared-assignments.json';
const integrationBranch = 'codex/pc-web-adaptation-integration';
const owners = ['芙宁娜', '纱雾'];

export function validateAdaptationQueues(matrix) {
  const errors = [];
  const pending = matrix.items.filter(row => row.workAssignment?.status?.endsWith('待办'));
  for (const row of pending) {
    const { owner, status } = row.workAssignment;
    if (!owners.includes(owner) || status !== owner + '待办')
      errors.push(`${row.id}: 待办标签与归属不一致`);
    if (row.fullAcceptance || row.crossBranchAcceptance)
      errors.push(`${row.id}: 已验收条目仍在待办队列`);
  }
  for (const owner of owners) {
    const positions = pending.filter(row => row.workAssignment.owner === owner)
      .map(row => row.workAssignment.queuePosition).sort((a, b) => a - b);
    if (positions.join(',') !== '1,2,3,4,5')
      errors.push(`${owner}: 待办序号必须为 1 至 5`);
  }
  return errors;
}

export function validateSharedAdaptationAssignments(assignments) {
  const errors = [];
  const accepted = new Set(assignments.acceptedById.map(row => row.id));
  const seen = new Set();
  for (const owner of owners) {
    const queue = assignments.queues[owner];
    if (queue.length !== 5) errors.push(`${owner}: 共用待办必须保留五项`);
    for (const { id } of queue) {
      if (accepted.has(id)) errors.push(`${id}: 已验收条目仍在共用待办队列`);
      if (seen.has(id)) errors.push(`${id}: 共用待办包含重复认领`);
      seen.add(id);
    }
  }
  return errors;
}

// Accounting validation only: evidence text is not proof of successful execution.
// Historical limited-flow categories, scoped observations and full acceptance stay separate.
export function validateFrontendProgress(matrix) {
  const errors = [];
  const items = matrix?.items;
  const accounting = matrix?.progressAccounting;
  if (!Array.isArray(items) || !accounting) return { errors: ['Missing items or progressAccounting'] };
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const byId = new Map(items.map(row => [row.id, row]));
  const inherited = items.filter(row => row.inheritedBaseline?.retained === true);
  const additions = items.filter(row => row.addedAt);
  check(byId.size === items.length, 'Expected unique item IDs');
  check(inherited.length === baselineSize, `Expected ${baselineSize} inherited items`);
  check(additions.length === accounting.addedClaudexItems, 'Claudex item count differs from the added rows');
  check(inherited.length + additions.length === items.length, 'Every row needs inherited or added provenance');
  for (let n = 1; n <= items.length; n++) {
    const id = `F${String(n).padStart(3, '0')}`;
    const row = byId.get(id);
    check(!!row, `Missing item ${id}`);
    if (!row) continue;
    if (n <= baselineSize) {
      check(row.inheritedBaseline?.retained === true && !row.addedAt, `${id}: inherited baseline not retained`);
    } else {
      check(present(row.addedAt) && !row.inheritedBaseline && !row.baselineState, `${id}: added row has invalid provenance`);
      check(present(row.officialUiReference) && present(row.acceptanceCriteria), `${id}: Claudex-specific UI reference or acceptance criteria missing`);
    }
  }
  const baselineCounts = count(inherited, 'baselineState');
  const currentCounts = count(items, 'currentAdaptationState');
  const cloudCounts = count(items, 'cloudState');
  for (const [field, actual, declared] of [
    ['baseline', baselineCounts, baseline],
    ['declared baseline', accounting.baselineCounts ?? {}, baseline],
    ['current adaptation', currentCounts, accounting.currentAdaptationCounts ?? {}],
  ]) {
    for (const key of new Set([...Object.keys(actual), ...Object.keys(declared)])) {
      check(actual[key] === declared[key], `${field}.${key}: actual ${actual[key]} != declared ${declared[key]}`);
    }
  }
  for (const row of items) {
    check(Object.hasOwn(baseline, row.currentAdaptationState), `${row.id}: unknown current category`);
    check(present(row.cloudState), `${row.id}: missing cloudState`);
    check(typeof row.fullAcceptance === 'boolean', `${row.id}: missing explicit fullAcceptance`);
  }
  check(accounting.sourceAuditItems === items.length, 'sourceAuditItems differs from item count');
  const notRevalidated = cloudCounts['not-revalidated'] ?? 0;
  check(accounting.currentRoundNotRevalidatedLabel === notRevalidated, `currentRoundNotRevalidatedLabel: actual ${notRevalidated} != declared ${accounting.currentRoundNotRevalidatedLabel}`);
  check(accounting.currentRoundOtherLocalEvidenceOrInProgressLabels === items.length - notRevalidated, 'Other local evidence/in-progress label count differs from cloudState complement');
  const liveIds = accounting.currentScopedLiveEvidenceIds;
  check(Array.isArray(liveIds), 'Missing explicit scoped-live IDs');
  check(new Set(liveIds ?? []).size === (liveIds ?? []).length, 'Duplicate scoped-live IDs');
  for (const id of liveIds ?? []) {
    const row = items.find(item => item.id === id);
    check(!!row, `${id}: scoped-live ID has no row`);
    if (!row) continue;
    const records = Object.entries(row).filter(([key]) => key.startsWith('live')).flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    check(records.some(record => record && typeof record === 'object'
      && ['candidate', 'candidateSequence', 'mainSha256', 'candidateMainSha256'].some(key => present(record[key]))
      && ['scope', 'actions', 'result', 'verified', 'observed', 'action'].some(key => present(record[key]))), `${id}: no candidate-bound actual scoped observation`);
    check(present(row.fullAcceptanceMeaning), `${id}: scoped evidence missing separate acceptance meaning`);
    check(present(row.remainingGates), `${id}: scoped evidence missing remaining scope boundaries`);
  }
  return { errors, baselineCounts, currentCounts, cloudCounts, scopedLiveIds: liveIds ?? [], fullAcceptanceCount: items.filter(row => row.fullAcceptance === true).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.argv[2];
  const fromRemote = source === '--integration';
  let integrationCommit;
  if (fromRemote) {
    const ref = `refs/heads/${integrationBranch}`;
    const remote = execFileSync('git', ['ls-remote', '--exit-code', 'origin', ref], { encoding: 'utf8' });
    integrationCommit = remote.trim().split('\t')[0];
    execFileSync('git', ['fetch', '--no-tags', 'origin', integrationCommit], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  const matrix = JSON.parse(integrationCommit
    ? execFileSync('git', ['show', `${integrationCommit}:${matrixPath}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    : readFileSync(source ?? matrixPath, 'utf8'));
  const report = validateFrontendProgress(matrix);
  report.errors.push(...validateAdaptationQueues(matrix));
  if (fromRemote) {
    const assignments = JSON.parse(execFileSync('git', ['show', `${integrationCommit}:${assignmentsPath}`], { encoding: 'utf8' }));
    report.errors.push(...validateSharedAdaptationAssignments(assignments));
    const owner = process.argv[3];
    const item = process.argv[4];
    if (!owners.includes(owner) || assignments.queues[owner][0]?.id !== item)
      report.errors.push(`${item ?? '缺少编号'}: 远端表未将该项登记为 ${owner ?? '指定负责人'} 的队首`);
    report.integrationCommit = integrationCommit;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}
