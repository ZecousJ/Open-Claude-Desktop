/** The unrecovered illustration is omitted from the original module. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { brandedModule } from '../scripts/official-web-assets.mjs';
import { deriveOfficialUiHostCapabilityModule, hostCapabilityRules, hostCapabilityOriginalHashes } from '../scripts/official-ui-host-capabilities.mjs';
const name='cc20c35ef-BByxoJKF.js';
const root=process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? '.restore/archive-extracted';
const sourceFile=path.join(root,'claude-frontend-4.4212.0/src/cloud/assets/v1',name);
const source=fs.readFileSync(sourceFile,'utf8');
const rule=hostCapabilityRules.find(r=>r.file===name);
assert.ok(rule);
test('unavailable install illustration has no substituted image',()=>{
 assert.equal(createHash('sha256').update(source).digest('hex'),hostCapabilityOriginalHashes[name]);
 const input=brandedModule(source), output=deriveOfficialUiHostCapabilityModule(name,input);
 assert.equal(input.split(rule.before).length,2);
 assert.equal(output,input.replace(rule.before,rule.after));
 assert.ok(input.includes('/images/CLI.png'));
 assert.ok(!output.includes('/images/CLI.png'));
 assert.equal(rule.after,'children: null');
 assert.ok(!output.includes('terminal-illustration-v1'));
 assert.equal(fs.readFileSync(sourceFile,'utf8'),source);
});
test('changed source or duplicate anchor fails closed, unrelated modules are untouched',()=>{
 const input=brandedModule(source);
 assert.throws(()=>deriveOfficialUiHostCapabilityModule(name,input+'\n'),/checksum mismatch/);
 assert.throws(()=>deriveOfficialUiHostCapabilityModule(name,input+rule.before),/checksum mismatch/);
 assert.equal(deriveOfficialUiHostCapabilityModule('unrelated.js','fixed'), 'fixed');
});
