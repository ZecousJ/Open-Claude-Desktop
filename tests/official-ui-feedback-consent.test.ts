/** Synthetic requests through the pinned protocol and real local reporting/persistence code. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { toJson } from '@bufbuild/protobuf';
import { loadRegistry, deepCreate } from '../electron/official-ui/api/timeline';
import { createActionRpc, PERFORM_ACTION_PATH } from '../electron/official-ui/api/actions';
import { messageIndex } from '../electron/official-ui/api/conversations';
import { newAdapterScope, inAdapterScope } from '../electron/official-ui/api/scope';
import { ReplyFeedback } from '../electron/conversations/reply-feedback';
import { DiagnosticsReporter } from '../electron/support/diagnostics';
import type { ClaudexBootstrap } from '../shared/claudex-contract';
import type { Conversation } from '../shared/types';

const applied = (value: any) => value.ack.applied === true || value.ack.outcome?.case === 'applied';
const refusal = (value: any) => value.ack.error ?? (value.ack.outcome?.case === 'error' ? value.ack.outcome.value : undefined);

test('consent refusal keeps the saved rating; retry sends or queues only supplied feedback, never conversation content', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f005-consent-'));
 const feedback = new ReplyFeedback(root);
 const registry = loadRegistry('build/official-ui/data/conversation-protocol.json');
 const schema = registry.getMessage('anthropic.bard.api.v1alpha.PerformActionRequest')!;
 let consent = false, enabled = true, networkFails = false;
 const posts: Array<{ route: string; body: any }> = [];
 const bootstrap = () => ({ features: { diagnostics: false, feedback: enabled }, feedback: { feedback: { enabled, allowConversationExcerpt: true } } }) as ClaudexBootstrap;
 const reporter = new DiagnosticsReporter({
  file: path.join(root, 'queue.json'), consented: () => consent,
  bootstrap: { current: bootstrap, refresh: async () => bootstrap(), onChange: () => () => {} },
  client: { appVersion: 'fixture', platform: 'linux', arch: 'x64' },
  post: async (route, body) => { posts.push({ route, body }); if (networkFails) throw Error('synthetic network failure'); return { accepted: true }; },
 });
 const conversation = { id: 'owned', mode: 'chat', model: 'fixture-model', turns: [{ id: 'turn', status: 'completed', prompt: 'PRIVATE_PROMPT_SENTINEL', items: [{ text: 'PRIVATE_REPLY_SENTINEL' }] }] } as unknown as Conversation;
 try {
  await inAdapterScope(newAdapterScope('f005-consent-fixture'), async () => {
   messageIndex.set('owned', new Map([['turn:assistant', { turnId: 'turn', kind: 'assistant', branchId: 'original', active: true }]]));
   const activation={};
   const route = createActionRpc({ account:()=>({id:'f005-consent-fixture'}), sessionIdentity:()=>activation, loadConversation:async()=>conversation, log() {}, call: async (name: string, ...args: any[]) => {
    if (name === 'setReplyFeedback') { feedback.set(args[0], args[1], args[2]); return; }
    if (name === 'submitReplyFeedback') return reporter.submitFeedback(conversation, args[0]);
    throw Error('Unexpected call: ' + name);
   } } as never, registry);
   let version = 0;
   async function request(type: number, comment?: string) {
    const message = deepCreate(schema, { header: { conversationId: 'owned', mutationId: { sessionId: 'consent', version: BigInt(++version) } }, action: { case: 'messageFeedback', value: { messageId: 'turn:assistant', type, ...(comment !== undefined ? { comment } : {}) } } });
    const req: any = Readable.from([Buffer.from(JSON.stringify(toJson(schema, message, { useProtoFieldName: true })))]);
    req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
    let result: any;
    assert.equal(await route(req, { writeHead() {}, end(value: any) { result = JSON.parse(String(value)); } } as never, PERFORM_ACTION_PATH), true);
    return result;
   }
   const refused = await request(3, 'synthetic feedback');
   assert.equal(applied(refused), false);
   assert.equal(refusal(refused).action, 'message_feedback');
   assert.equal(posts.length, 0);
   assert.equal(new ReplyFeedback(root).all()[JSON.stringify(['owned', 'turn'])], 'down');
   consent = true;
   assert.equal(applied(await request(3, 'synthetic feedback')), true);
   assert.equal(posts.length, 1);
   assert.equal(posts[0].route, 'feedback');
   assert.equal(posts[0].body.conversation_excerpt, null);
   assert.equal(posts[0].body.comment, 'synthetic feedback');
   assert.doesNotMatch(JSON.stringify(posts), /PRIVATE_PROMPT_SENTINEL|PRIVATE_REPLY_SENTINEL/);
   networkFails = true;
   assert.equal(applied(await request(3)), true);
   assert.equal(posts.length, 2);
   assert.equal(reporter.pending.feedback, 1);
   assert.equal(posts[1].body.comment, '');
   assert.equal(posts[1].body.conversation_excerpt, null);
   const before = posts.length;
   assert.equal(applied(await request(1)), true);
   assert.equal(new ReplyFeedback(root).all()[JSON.stringify(['owned', 'turn'])], 'up');
   assert.equal(applied(await request(0)), true);
   assert.deepEqual(new ReplyFeedback(root).all(), {});
   assert.equal(posts.length, before);
   enabled = false;
   reporter.statusAt = 0;
   assert.ok(refusal(await request(3, 'disabled service')));
   assert.equal(posts.length, before);
  });
 } finally { reporter.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
