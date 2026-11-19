import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostStaticPreviewRules } from '../../scripts/official-ui-host-static-preview.mjs';

test('artifact review follows the authenticated host capability', () => {
 const rule = hostStaticPreviewRules.find(r => r.name === 'chat-artifact-review-own-saved-markdown');
 const expression = rule.after.trim().replace(/^xi = /, '').replace(/,$/, '');
 const evaluate = new Function('__claudexArtifactAccount', 'bi', 'yi', 'J', 'H', 'k', 'ne', 'Ht', 'S', 'Z', '$e', 'X', `return ${expression};`);
 const show = (account, original = false) => evaluate(account, original, false, {type:'markdown',versions:[{}]}, {Markdown:'markdown'}, false, false, false, true, true, true, 0);
 const auth = {status:'authenticated'};
 assert.equal(show({claudex_host_authentication:auth}), false);
 assert.equal(show({claudex_host_authentication:auth}, true), false);
 assert.equal(show({claudex_host_authentication:auth,claudex_chat_artifact_review:true}), true);
 assert.equal(show({}, true), true);
});
