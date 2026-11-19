import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { brandedModule, verifyHostCodeDerivationSet } from '../../scripts/official-web-assets.mjs';
import { deriveOfficialUiHostCodeCapabilityModule, hostCodeCapabilityRevision, hostCodeCapabilityOriginalHashes } from '../../scripts/official-ui-host-code-capability.mjs';
import { deriveOfficialUiHostWorkspaceTrustModule } from '../../scripts/official-ui-host-workspace-trust.mjs';
import { deriveOfficialUiHostSkillSearchModule } from '../../scripts/official-ui-host-skill-search.mjs';
const file = 'shared-l-p-m-w-3-B5uNmf7O.js';
const root = path.resolve(import.meta.dirname, '../..');
const raw = fs.readFileSync(path.join(root, '.restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1', file));
assert.equal(createHash('sha256').update(raw).digest('hex'), hostCodeCapabilityOriginalHashes[file]);
const branded = brandedModule(raw.toString());
const transformed = deriveOfficialUiHostCodeCapabilityModule(file, branded);
const current = () => ({hostDerivationSet:'claudex-host-code-navigation-v1', hostCodeCapability:{revision:hostCodeCapabilityRevision},hostAuth:{},hostInstalledPlugins:{},hostSkillSearch:{}});
// Execute the production final derivation and exact byte-comparison statements,
// without rebuilding the archive or evaluating any official module.
const verifier = fs.readFileSync(path.join(root, 'scripts/official-web-assets.mjs'), 'utf8');
const start = verifier.indexOf('          const skillAware =');
const end = verifier.indexOf('      const content = deriveOfficialWebAccountModule', start);
assert.ok(start > 0 && end > start);
const tail = 'if (true) { if (true) {\n' + verifier.slice(start, end);
function verifyBytes(meta, bytes) {
  verifyHostCodeDerivationSet(meta);
  vm.runInNewContext(tail, {
    meta, bytes: Buffer.from(bytes), expected: null, Buffer, name: file,
    relative: 'assets/v1/' + file, pluginAware: branded,
    deriveOfficialUiHostCodeCapabilityModule,
    deriveOfficialUiHostSkillSearchModule,
    deriveOfficialUiHostWorkspaceTrustModule,
    options: {}, desktopSessionExport: undefined,
  });
}
test('new coherent set verifies exact Code bytes and rejects missing or unknown metadata', () => {
  verifyBytes(current(), transformed);
  for (const change of [m=>delete m.hostCodeCapability,m=>delete m.hostDerivationSet,m=>m.hostDerivationSet='unknown',m=>m.hostCodeCapability.revision='unknown',m=>delete m.hostAuth,m=>delete m.hostInstalledPlugins,m=>delete m.hostSkillSearch]) {
    const meta=current();change(meta);assert.throws(()=>verifyBytes(meta,transformed));
  }
});
test('deleting both new markers cannot authorize changed bytes; exact historical bytes remain valid', () => {
  const old=current();delete old.hostCodeCapability;delete old.hostDerivationSet;
  assert.throws(()=>verifyBytes(old,transformed),/differs from approved exact source derivation/);
  verifyBytes(old,branded);
  assert.throws(()=>verifyBytes(current(),transformed+' '),/differs from approved exact source derivation/);
});
test('assembler installs and records the same final derivation and verifier checks original hashes and rules', () => {
  const build=fs.readFileSync(path.join(root,'scripts/build-official-ui.mjs'),'utf8');
  assert.ok(build.indexOf('applyOfficialUiHostCodeCapability(modulesDir)')>build.indexOf('applyOfficialUiHostSkillSearch(modulesDir)'));
  assert.match(build,/hostWorkspaceTrust \? "claudex-host-workspace-trust-v1" : null/);
  assert.match(verifier,/\[meta.hostCodeCapability, hostCodeCapabilityInputHashes, hostCodeCapabilityRules, hostCodeCapabilityOriginalHashes, null\]/);
  assert.match(verifier,/r\.originalSha256 !== originalHashes\[name\]/);
  assert.match(verifier,/r\.outputSha256 !== output/);
});
