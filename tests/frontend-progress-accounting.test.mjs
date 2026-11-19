import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAdaptationQueues, validateFrontendProgress } from '../scripts/validate-frontend-progress.mjs';
const read = () => JSON.parse(readFileSync(new URL('../docs/handoff/cloud-frontend-batch-20261103/item-matrix.json', import.meta.url), 'utf8'));
test('canonical accounting matches rows without interpreting scoped evidence as completion', () => {
  const report = validateFrontendProgress(read());
  assert.deepEqual(report.errors, []);
  assert.equal(Object.values(report.baselineCounts).reduce((a, b) => a + b, 0), 163);
});
test('Claudex additions count toward current coverage and retain the original baseline', () => {
  const matrix = read();
  const original = matrix.items.filter(row => row.inheritedBaseline?.retained);
  const additions = matrix.items.filter(row => row.addedAt);
  assert.equal(original.length, 163);
  assert.equal(additions.length, matrix.progressAccounting.addedClaudexItems);
  for (const row of additions) {
    assert.ok(row.officialUiReference.length > 0);
    assert.ok(row.acceptanceCriteria.length > 0);
  }
  const first = additions[0];
  delete first.officialUiReference;
  assert.ok(validateFrontendProgress(matrix).errors.some(error => error.includes(first.id)));
});
test('each owner has five distinct positions and closed items cannot be reassigned', () => {
  const matrix = read();
  assert.deepEqual(validateAdaptationQueues(matrix), []);
  const [head, next] = matrix.items.filter(row => row.workAssignment?.status === '芙宁娜待办');
  head.crossBranchAcceptance = { owner: '纱雾' };
  next.workAssignment.queuePosition = head.workAssignment.queuePosition;
  assert.match(validateAdaptationQueues(matrix).join('\n'), /已验收条目仍在待办队列/);
  assert.match(validateAdaptationQueues(matrix).join('\n'), /待办序号必须为 1 至 5/);
});
test('rejects stale cloud count, category drift and duplicate IDs', () => {
  for (const mutate of [
    x => { x.progressAccounting.currentRoundNotRevalidatedLabel++; },
    x => { x.progressAccounting.currentRoundOtherLocalEvidenceOrInProgressLabels--; },
    x => { x.progressAccounting.currentAdaptationCounts.P++; },
    x => { x.items[0].baselineState = 'N'; },
    x => { x.items[0].id = x.items[1].id; },
  ]) {
    const matrix = read(); mutate(matrix);
    assert.ok(validateFrontendProgress(matrix).errors.length > 0);
  }
});
test('live ID requires candidate-bound observation, not merely fullAcceptance or a label', () => {
  const matrix = read();
  const row = matrix.items.find(item => item.id === matrix.progressAccounting.currentScopedLiveEvidenceIds[0]);
  for (const key of Object.keys(row)) if (key.startsWith('live')) delete row[key];
  row.fullAcceptance = true;
  assert.ok(validateFrontendProgress(matrix).errors.some(error => error.includes('candidate-bound')));
});
test('scoped evidence is independently counted and does not overwrite inherited categories', () => {
  const matrix = read();
  const before = validateFrontendProgress(matrix);
  matrix.progressAccounting.currentScopedLiveEvidenceIds = [];
  const after = validateFrontendProgress(matrix);
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.baselineCounts, before.baselineCounts);
  assert.deepEqual(after.currentCounts, before.currentCounts);
  assert.equal(after.fullAcceptanceCount, before.fullAcceptanceCount);
});
