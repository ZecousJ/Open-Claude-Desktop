import test from 'node:test';
import assert from 'node:assert/strict';
import webConfig, {webDevDeny, webDevWatchIgnored} from '../../vite.web.config.ts';

test('Web development configuration excludes local acceptance profiles from watching and file serving', () => {
  for (const entry of ['**/.runtime/**', '**/.restore/**']) {
    assert.ok(webDevWatchIgnored.includes(entry));
    assert.ok(webDevDeny.includes(entry));
  }
  assert.ok(webDevWatchIgnored.includes('**/backend/**'));
  const server = (webConfig as any).server;
  assert.deepEqual(server.watch.ignored, webDevWatchIgnored);
  assert.deepEqual(server.fs.deny, webDevDeny);
  assert.equal(server.host, '127.0.0.1');
  assert.equal(server.port, 5174);
  assert.equal(server.strictPort, true);
  for (const source of ['src', 'src-web', 'shared', 'scripts', 'build/official-ui'])
    assert.ok(!webDevWatchIgnored.includes(`**/${source}/**`));
});
