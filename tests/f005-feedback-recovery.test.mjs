/** Recovery-only handler tests. JSON decoding and imported dependencies are inert
 * stubs; these do not replace pinned-protobuf or original-UI acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Readable } from 'node:stream';
import ts from 'typescript';

const filename = new URL('../electron/official-ui/api/actions.ts', import.meta.url);
const source = fs.readFileSync(filename, 'utf8');
const ast = ts.createSourceFile('actions.ts', source, ts.ScriptTarget.Latest, true);
assert.equal(ast.parseDiagnostics.length, 0);
const isolated = ast.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(isolated, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics?.length ?? 0, 0);

const feedbackSource = fs.readFileSync(new URL('../electron/official-ui/api/reply-feedback.ts', import.meta.url), 'utf8');
const feedbackAst = ts.createSourceFile('reply-feedback.ts', feedbackSource, ts.ScriptTarget.Latest, true);
const feedbackIsolated = feedbackAst.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(feedbackAst)).join('\n');
const feedbackCompiled = ts.transpileModule(feedbackIsolated, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

async function request(type, outcome = { sent: true }, options = {}) {
  const calls = [];
  const env = {
    exports: {}, Buffer, Error, Set, Map,
    ScopedMap: class extends Map { constructor() { super(); } },
    assistantMessageId: () => "reply",
    completedReply: (conversation, id) => conversation.turns.find(turn => turn.id === id && turn.status === "completed"),
    fromJson: (_schema, value) => value,
    resolveConversationId: id => id,
    messageRef: (conversationId, messageId) => conversationId === 'owned' && messageId === 'reply'
      ? { turnId: 'turn', kind: options.kind ?? 'assistant', active: true } : undefined,
  };
  vm.runInNewContext(`(function () { ${feedbackCompiled.outputText} })()`, env, { filename: 'reply-feedback.ts' });
  env.applyReplyFeedback = env.exports.applyReplyFeedback;
  vm.runInNewContext(compiled.outputText, env, { filename: 'actions.ts' });
  const registry = {
    getMessage: name => ({ name }),
    getEnum: () => ({ values: [0, 1, 2, 3, 4, 5].map(number => ({ number })) }),
  };
  const activation = {};
  const rpc = env.exports.createActionRpc({
    account: () => ({id:'fixture'}), sessionIdentity: () => activation,
    loadConversation: async () => ({id:'owned',mode:'chat',turns:[{id:'turn',status:'completed'}]}),
    log() {},
    async call(name, ...args) {
      calls.push([name, ...args]);
      if (name === 'setReplyFeedback' && options.ratingFails) throw Error('inert rating failure');
      if (name === 'submitReplyFeedback') {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
    },
  }, registry);
  const header = { conversationId: options.foreign ? 'other' : 'owned' };
  if (!options.noMutation) header.mutationId = { sessionId: 'feedback-mutation', version: 7 };
  const body = { header, action: { case: 'messageFeedback', value: {
    messageId: 'reply', type, ...(Object.hasOwn(options, 'comment') ? { comment: options.comment } : {}),
  } } };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
  let answer, status;
  const res = { writeHead(value) { status = value; }, end(value) { answer = JSON.parse(value); } };
  assert.equal(await rpc(req, res, env.exports.PERFORM_ACTION_PATH), true);
  assert.equal(status, 200);
  return { answer, calls: JSON.parse(JSON.stringify(calls)) };
}
const applied = result => result.answer.ack.outcome.case === 'applied';
const failure = result => result.answer.ack.outcome.value;

test('not-sent and thrown reports settle the original message_feedback mutation', async () => {
  for (const outcome of [{ sent: false }, null, Error('private internal marker')]) {
    const r = await request(1, outcome, { comment: 'inert report' });
    assert.equal(applied(r), false);
    assert.equal(failure(r).action, 'message_feedback');
    assert.deepEqual(r.answer.ack.highWaterMark, { sessionId: 'feedback-mutation', version: 7 });
    assert.equal(r.calls.length, 2);
    assert.doesNotMatch(JSON.stringify(r.answer), /private internal marker/);
  }
});
test('category-only reports submit their category and an empty comment', async () => {
  for (const type of [3, 4, 5]) {
    const r = await request(type);
    assert.equal(applied(r), true);
    assert.deepEqual(r.calls, [
      ['setReplyFeedback', 'owned', 'turn', 'down', {localOnly:true}],
      ['submitReplyFeedback', { conversationId: 'owned', turnId: 'turn', rating: 'down', categories: [String(type)], comment: '' }],
    ]);
  }
});
test('category-only failures are not mistaken for sent reports', async () => {
  const r = await request(3, { sent: false });
  assert.equal(applied(r), false); assert.equal(failure(r).action, 'message_feedback');
  assert.equal(r.calls.length, 2);
});
test('sent and queued reports are accepted exactly once', async () => {
  for (const outcome of [{ sent: true }, { sent: false, queued: true }]) {
    const r = await request(2, outcome, { comment: 'inert report' });
    assert.equal(applied(r), true); assert.equal(r.calls.length, 2);
  }
});
test('clear and bare thumbs preserve rating-only behavior', async () => {
  for (const [type, rating] of [[0, null], [1, 'up'], [2, 'down']]) {
    const r = await request(type);
    assert.equal(applied(r), true);
    assert.deepEqual(r.calls, [['setReplyFeedback', 'owned', 'turn', rating, {localOnly:true}]]);
  }
});
test('explicit empty comment is still an intentional report submission', async () => {
  const r = await request(1, { sent: true }, { comment: '' });
  assert.equal(applied(r), true); assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1][1].comment, '');
});
test('validation refusals correlate without making service mutations', async () => {
  for (const [type, options] of [[999, {}], [1, { kind: 'user' }], [1, { foreign: true }], [1, { comment: 'x'.repeat(4001) }]]) {
    const r = await request(type, { sent: true }, options);
    assert.equal(applied(r), false); assert.equal(r.calls.length, 0);
    assert.equal(failure(r).action, 'message_feedback');
    assert.deepEqual(r.answer.ack.highWaterMark, { sessionId: 'feedback-mutation', version: 7 });
  }
});
test('rating persistence failure does not submit a report and is correlated', async () => {
  const r = await request(3, { sent: true }, { ratingFails: true });
  assert.equal(applied(r), false); assert.equal(r.calls.length, 1);
  assert.equal(failure(r).action, 'message_feedback');
  assert.deepEqual(r.answer.ack.highWaterMark, { sessionId: 'feedback-mutation', version: 7 });
});
test('legacy requests without a mutation do not fabricate correlation', async () => {
  const r = await request(3, { sent: false }, { noMutation: true });
  assert.equal(applied(r), false); assert.equal(failure(r).action, 'message_feedback');
  assert.equal(r.answer.ack.highWaterMark, undefined);
});
