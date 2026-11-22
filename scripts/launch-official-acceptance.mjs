/** Local cloud-desktop acceptance only. Inherit its EXISTING system proxy/CA, never invent egress or persist credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runAcceptanceChild } from './acceptance-child-lifecycle.mjs';
import { fileURLToPath } from 'node:url';
const keys = ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE'];
export function acceptanceEnvironment(source, inherited) {
  const env = {...inherited};
  for (const key of keys) {
    const lines = source.split(/\r?\n/).filter(line => line.startsWith(key+'='));
    if (lines.length !== 1) throw Error('Existing desktop network configuration is incomplete or ambiguous.');
    let value = lines[0].slice(key.length+1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
    if (!value || /[\r\n`$\\]/.test(value)) throw Error('Unsupported system environment literal.');
    if (key.endsWith('_PROXY') && key !== 'NO_PROXY') {
      const url = new URL(value);
      if (!['http:','https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash)
        throw Error('Unsupported existing desktop proxy configuration.');
    }
    env[key]=value;
  }
  // Lowercase aliases cannot accidentally override the selected EXISTING configuration.
  for (const key of ['http_proxy','https_proxy','no_proxy']) env[key]=env[key.toUpperCase()];
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || /--(?:ignore-certificate-errors|no-sandbox)/.test(env.NODE_OPTIONS ?? ''))
    throw Error('Insecure inherited process options are not allowed.');
  env.NODE_USE_ENV_PROXY='1';
  return env;
}
const self=fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1])===self) {
  const mode=process.argv[2];
  if (!['probe','app','web'].includes(mode) || process.argv.length!==3) throw Error('Use probe, app or web only.');
  const cwd=path.resolve(path.dirname(self),'..');
  const env=acceptanceEnvironment(fs.readFileSync('/etc/environment','utf8'),process.env);
  env.CLAUDEX_DATA_DIR=path.join(cwd,'.runtime/native-live-profile');
  env.CLAUDEX_ACCEPTANCE_NETWORK_DIAGNOSTICS='1';
  env.CLAUDEX_SUB2API_URL='https://claudex.zecous.cn';
  env.CLAUDEX_WEB_API='https://claudex.zecous.cn';
  const target=mode==='probe'?'.runtime/electron-network-probe.cjs':'.';
  console.log('Launching acceptance '+mode+' with existing desktop proxy/CA; certificate verification remains enabled.');
  const executable=mode==='web'?process.execPath:path.join(cwd,'node_modules/electron/dist/electron');
  const args=mode==='web'?['node_modules/vite/bin/vite.js','--config','vite.official-web.config.ts']:[target];
  const buildSha256=createHash('sha256').update(fs.readFileSync(path.join(cwd,mode==='web'?'vite.official-web.config.ts':mode==='probe'?'.runtime/electron-network-probe.cjs':'dist-electron/main.js'))).digest('hex');
  const result=await runAcceptanceChild({command:executable,args,cwd,env,buildSha256},{spawn,signals:process,log:record=>console.log('[acceptance-child]',JSON.stringify({...record,fingerprintKind:mode==='web'?'web-dev-config':mode==='probe'?'network-probe':'native-bundle'}))});
  process.exitCode=result.code ?? 1;
}
