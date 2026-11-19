/** Extract the original modal callbacks; these are not a replacement modal. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as patch from '../scripts/official-ui-reply-feedback-settlement.mjs';

const root = process.env.CLAUDEX_OFFICIAL_UI_SOURCE ?? '../claude-frontend-4.4212.0';
const rawFile = path.join(root, 'src/cloud/assets/v1', patch.replyFeedbackSettlementTarget);
const original = fs.readFileSync(rawFile, 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');
const branded = original.replace(/(defaultMessage:\s*)("(?:[^"\\\n]|\\.)*")/g, (_match, prefix, quoted) =>
 prefix + JSON.stringify(JSON.parse(quoted).replace(/\bclaude\.ai\b/g, 'Claudex').replace(/\bAnthropic\b/g, 'Claudex').replace(/\bClaude\b/g, 'Claudex')))
 .replace(/(?<!id: )"Claude( Code| Nest)?"/g, (_match, suffix) => `"Claudex${suffix ?? ''}"`);
const derived = patch.deriveOfficialReplyFeedbackSettlementModule(patch.replyFeedbackSettlementTarget, branded);
const component = derived.slice(derived.indexOf('function $V(e) {'), derived.indexOf('\nfunction rA(e) {'));
function between(start, end) {
 const index = component.indexOf(start), stop = component.indexOf(end, index);
 assert.ok(index >= 0 && stop > index, start);
 assert.equal(component.indexOf(start, index + start.length), -1, 'unique callback');
 return component.slice(index, stop);
}
const closeSource = between('() => {\n          let e = x.current;', '\n        })');
const settleSource = between('(e, t) => {\n                let r = A.current', '\n              },\n              a,') + '\n              }';
const cancelSource = between('() => {\n          (++__claudexFeedbackEpoch.current', '\n        })');
const submitSource = between('() => {\n            if (!r || !a) return;', '\n          })');
function fixture({ comment = 'synthetic draft', success } = {}) {
 const calls = [], kept = [];
 const env = { A: { current: true }, __claudexFeedbackEpoch: { current: 0 }, a: true, n: { uuid: 'reply' },
  r: 'flag_other', x: { current: comment }, T: { current: undefined }, ye: false, EA: { kind: 'idle' },
  state: { kind: 'idle' }, closed: 0, submitted: [], u: success,
  _: value => kept.push(value), o: () => { env.closed++; env.a = false; },
  O: next => { env.state = typeof next === 'function' ? next(env.state) : next; },
  R: (...args) => calls.push(args), c: type => env.submitted.push(type),
 };
 vm.createContext(env);
 env.E = vm.runInContext('(' + closeSource + '\n})', env);
 env.P = vm.runInContext('(' + settleSource + ')', env);
 const cancel = vm.runInContext('(' + cancelSource + '\n})', env);
 const submit = vm.runInContext('(' + submitSource + '\n})', env);
 return { env, calls, kept, cancel, submit, outcome: (index, result) => calls[index][3](result) };
}
test('exact original and branding inputs produce the reviewed deterministic output', () => {
 assert.equal(sha(original), patch.replyFeedbackSettlementOriginalSha256);
 assert.equal(sha(branded), patch.replyFeedbackSettlementInputSha256);
 assert.equal(sha(derived), patch.replyFeedbackSettlementOutputSha256);
 assert.match(component, /Ratings are saved to your account/);
 assert.match(component, /评分保存在你的账户中/);
 assert.equal(fs.readFileSync(rawFile, 'utf8'), original);
 const before = branded.indexOf('function $V(e) {'), after = branded.indexOf('\nfunction rA(e) {');
 assert.equal(derived.slice(0, before), branded.slice(0, before));
 assert.equal(derived.slice(derived.indexOf('\nfunction rA(e) {')), branded.slice(after));
});
test('unrelated modules pass through unchanged', () => assert.equal(patch.deriveOfficialReplyFeedbackSettlementModule('other.js', 'unchanged'), 'unchanged'));
test('source drift and repeated application fail closed', () => {
 for (const source of [branded + '\n', derived, original]) assert.throws(() => patch.deriveOfficialReplyFeedbackSettlementModule(patch.replyFeedbackSettlementTarget, source), /input mismatch/);
});
test('application writes only a separate assembled module with a strict manifest', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f005-assembly-'));
 try {
  fs.writeFileSync(path.join(dir, patch.replyFeedbackSettlementTarget), branded);
  const manifest = patch.applyOfficialReplyFeedbackSettlement(dir);
  assert.equal(fs.readFileSync(path.join(dir, patch.replyFeedbackSettlementTarget), 'utf8'), derived);
  patch.verifyOfficialReplyFeedbackSettlementManifest(manifest, [{ path: 'assets/v1/' + patch.replyFeedbackSettlementTarget, sha256: sha(derived) }], sha(derived));
  assert.equal(fs.readFileSync(rawFile, 'utf8'), original);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('application refuses restored sources and linked files/directories', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f005-boundaries-'));
 try {
  const restore = path.join(dir, '.restore'); fs.mkdirSync(restore);
  fs.writeFileSync(path.join(restore, patch.replyFeedbackSettlementTarget), branded);
  assert.throws(() => patch.applyOfficialReplyFeedbackSettlement(restore), /assembly output/);
  const linked = path.join(dir, 'linked'); fs.symlinkSync(restore, linked);
  assert.throws(() => patch.applyOfficialReplyFeedbackSettlement(linked), /assembly output/);
  fs.symlinkSync(path.join(restore, patch.replyFeedbackSettlementTarget), path.join(dir, patch.replyFeedbackSettlementTarget));
  assert.throws(() => patch.applyOfficialReplyFeedbackSettlement(dir), /Linked/);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('manifest verification rejects spoofed metadata, absent/duplicate output rows and incorrect hashes', () => {
 const manifest = { revision: patch.replyFeedbackSettlementRevision, modules: [{ file: patch.replyFeedbackSettlementTarget, originalSha256: sha(original), inputSha256: sha(branded), outputSha256: sha(derived) }] };
 const row = { path: 'assets/v1/' + patch.replyFeedbackSettlementTarget, sha256: sha(derived) };
 for (const value of [{ ...manifest, extra: true }, { ...manifest, revision: 'other' }, { ...manifest, modules: [] }]) assert.throws(() => patch.verifyOfficialReplyFeedbackSettlementManifest(value, [row], sha(derived)), /manifest mismatch/);
 for (const rows of [[], [row, row], [{ ...row, sha256: sha(branded) }]]) assert.throws(() => patch.verifyOfficialReplyFeedbackSettlementManifest(manifest, rows, sha(derived)), /file mismatch/);
 assert.throws(() => patch.verifyOfficialReplyFeedbackSettlementManifest(manifest, [row], sha(branded)), /manifest mismatch/);
});
test('ordinary feedback without optional onSuccess waits in Sending until recorded', () => {
 const f = fixture(); f.submit();
 assert.equal(f.env.state.kind, 'sending'); assert.equal(f.env.closed, 0); assert.equal(f.calls.length, 1);
 assert.equal(f.calls[0][1], 'flag_other'); assert.equal(f.calls[0][2], 'synthetic draft');
 assert.equal(f.outcome(0, { kind: 'recorded' }), true);
 assert.equal(f.env.state.kind, 'idle'); assert.equal(f.env.closed, 1); assert.deepEqual(f.kept, ['']);
});
test('refusal retains comment/category and retry uses the original callback', () => {
 const f = fixture(); f.submit(); f.outcome(0, { kind: 'notRecorded', message: 'not sent' });
 assert.equal(f.env.state.kind, 'notRecorded'); assert.equal(f.env.state.line, 'not sent'); assert.equal(f.env.closed, 0);
 assert.equal(f.env.x.current, 'synthetic draft'); assert.equal(f.env.r, 'flag_other');
 f.submit(); assert.equal(f.env.state.kind, 'sending'); f.outcome(1, { kind: 'recorded' }); assert.equal(f.env.closed, 1);
});
test('category-only reports retain the category and optional empty comment', () => {
 const f = fixture({ comment: '' }); f.submit(); assert.equal(f.calls[0][1], 'flag_other'); assert.equal(f.calls[0][2], undefined);
 f.outcome(0, { kind: 'recorded' }); assert.equal(f.env.closed, 1);
});
test('cancel preserves a pending draft and invalidates its late success', () => {
 const f = fixture(); f.submit(); f.cancel(); assert.deepEqual(f.kept, ['synthetic draft']); assert.equal(f.env.state.kind, 'idle');
 f.env.a = true; f.env.x.current = 'new draft'; f.outcome(0, { kind: 'recorded' });
 assert.equal(f.env.closed, 1); assert.equal(f.env.x.current, 'new draft'); assert.deepEqual(f.kept, ['synthetic draft']);
});
test('old success/refusal cannot settle a newer request after cancel and reopen', () => {
 const f = fixture(); f.submit(); f.cancel(); f.env.a = true; f.env.x.current = 'new draft'; f.submit();
 f.outcome(0, { kind: 'recorded' }); f.outcome(0, { kind: 'notRecorded', message: 'stale failure' });
 assert.equal(f.env.state.kind, 'sending'); assert.equal(f.env.closed, 1);
 f.outcome(1, { kind: 'notRecorded', message: 'current refusal' }); assert.equal(f.env.state.line, 'current refusal');
 f.submit(); f.outcome(2, { kind: 'recorded' }); assert.equal(f.env.closed, 2); assert.deepEqual(f.kept, ['synthetic draft', '']);
});
test('unmounted modal ignores late settlement', () => {
 let successes = 0; const f = fixture({ success: () => successes++ }); f.submit(); f.env.A.current = false;
 f.outcome(0, { kind: 'recorded' }); assert.equal(f.env.closed, 0); assert.equal(successes, 0);
});
test('optional success callback is preserved for the current accepted request', () => {
 let successes = 0; const f = fixture({ success: () => successes++ }); f.submit(); f.outcome(0, { kind: 'recorded' }); assert.equal(successes, 1); assert.equal(f.env.closed, 1);
});
test('modal disclosure states the local rating and consent boundary in English and Chinese', () => {
 assert.doesNotMatch(component, /Submitting this report will send the entire current conversation|children: fe\n\s*\? It\(gZ/);
 assert.match(component, /Conversation content is not included/); assert.match(component, /不包含对话内容/);
 assert.match(component, /enabled sharing and the service supports it/);
});
