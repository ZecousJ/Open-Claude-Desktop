import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../electron/store/store';
import { safeActivationFailureSummary } from '../../electron/account/activation-failure';

// No actual account, session, provider key or profile is used. These tests
// exercise the Store.flush shared by prepare and failed-activation cleanup.
test('real empty Store supports initial, prepare and cleanup flush plus reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-login-empty-store-'));
  try {
    const store = new Store(root);
    store.settings.name = 'Synthetic local account';
    store.flush();
    store.flush();
    store.flush();
    const reopened = new Store(root);
    assert.deepEqual(reopened.settings, store.settings);
    assert.deepEqual(reopened.conversations, []);
    assert.deepEqual(reopened.projects, []);
    for (const file of ['settings.json', 'conversations.json', 'projects.json']) {
      assert.equal(fs.statSync(path.join(root, file)).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(path.join(root, file + '.tmp')), false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real flush failure at its first write propagates errno on both calls without replacing saved data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-login-blocked-store-'));
  try {
    const store = new Store(root);
    store.flush();
    const files = ['settings.json', 'conversations.json', 'projects.json'];
    const before = files.map(file => fs.readFileSync(path.join(root, file)));
    // A local inert filesystem fault, not a permission or sandbox change.
    fs.mkdirSync(path.join(root, 'settings.json.tmp'));
    for (const phase of ['prepare', 'cleanup']) {
      assert.throws(() => store.flush(), (error: unknown) => {
        assert.ok(error instanceof Error, phase);
        assert.equal((error as NodeJS.ErrnoException).code, 'EISDIR', phase);
        assert.deepEqual(safeActivationFailureSummary(error), [{ kind: 'Error', code: 'EISDIR' }]);
        return true;
      });
    }
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[i]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
