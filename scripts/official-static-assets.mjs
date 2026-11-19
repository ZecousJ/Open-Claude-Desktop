import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
export const digest = b => createHash('sha256').update(b).digest('hex');
export async function scanStaticImages(ui) {
  const references = new Map();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!/\.(js|css|html)$/.test(file)) continue;
      const source = await fs.readFile(file, 'utf8');
      for (const match of source.matchAll(new RegExp('/images/[A-Za-z0-9_./-]+[.](?:gif|png|webp|svg|jpg|jpeg|avif)(?![A-Za-z0-9_.-])', 'g'))) {
        const name = match[0];
        if (name.includes('..')) throw Error('Invalid asset path: ' + name);
        if (!references.has(name)) references.set(name, new Set());
        references.get(name).add(path.relative(ui, file));
      }
    }
  }
  await walk(ui);
  return [...references].sort(([a], [b]) => a.localeCompare(b)).map(([name, modules]) => ({ path: name, modules: [...modules].sort() }));
}
const mime = { '.gif': 'image/gif', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.avif': 'image/avif' };
function validImage(bytes, extension) {
  if (extension === '.svg') return /<svg[\s>]/i.test(bytes.toString('utf8')) && !/<html[\s>]/i.test(bytes.toString('utf8'));
  if (extension === '.gif') return /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString());
  if (extension === '.png') return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (extension === '.webp') return bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (extension === '.jpg' || extension === '.jpeg') return bytes[0] === 255 && bytes[1] === 216;
  return extension === '.avif' && bytes.toString('ascii',4,12).includes('ftyp');
}
export async function prepareStaticImages({ root = path.resolve('build/official-ui'), capture = false } = {}) {
  const ui = path.join(root, 'ui'), manifestFile = path.resolve('docs/official-ui-static-assets.json'), cache = path.resolve('build/official-static-assets');
  const refs = await scanStaticImages(ui);
  const previous = JSON.parse(await fs.readFile(manifestFile,'utf8').catch(() => '{"assets":[]}'));
  const known = new Map(previous.assets.map(r => [r.path,r]));
  const unavailable = new Map((previous.unavailable ?? []).map(r => [r.path, r]));
  const results = [], failures = [];
  let cursor = 0;
  await Promise.all(Array.from({length: 8}, async () => {
    while (cursor < refs.length) {
      const ref = refs[cursor++], pinned = known.get(ref.path), destination = path.join(ui, ref.path), cached = path.join(cache, ref.path);
      const expected = pinned?.sha256 ?? (ref.path === '/images/clawd/core/Clawd-CrabWalking.gif' ? 'a30f029d3df75d72bb11c13e84b6ae51ecbbdeb4ab70a0274eb169fa5909a95f' : undefined);
      try {
        if (!capture && unavailable.has(ref.path)) { failures.push({...ref,...unavailable.get(ref.path),knownUnavailable:true}); continue; }
        if (!capture && !expected) throw Error('Unpinned asset; run --capture and review the manifest');
        let bytes;
        for (const file of [destination,cached]) {
          const candidate = await fs.readFile(file).catch(() => null);
          if (candidate && validImage(candidate,path.extname(ref.path)) && (!expected || digest(candidate) === expected)) { bytes = candidate; break; }
        }
        if (!bytes) {
          await fs.mkdir(path.dirname(cached),{recursive:true});
          const temp = cached + '.' + process.pid + '.download';
          try {
            await exec('curl',['--fail','--silent','--show-error','--retry','2','--max-time','45','--max-filesize','20971520','https://claude.ai' + ref.path,'-o',temp]);
            bytes = await fs.readFile(temp);
          } finally { await fs.rm(temp,{force:true}); }
        }
        if (!validImage(bytes,path.extname(ref.path))) throw Error('Response is not the expected image type');
        const sha256 = digest(bytes);
        if (expected && sha256 !== expected) throw Error('Pinned content checksum mismatch');
        await fs.mkdir(path.dirname(cached),{recursive:true});
        await fs.writeFile(cached,bytes);
        await fs.mkdir(path.dirname(destination),{recursive:true});
        await fs.writeFile(destination,bytes);
        results.push({...ref,url:'https://claude.ai'+ref.path,mime:mime[path.extname(ref.path)],bytes:bytes.length,sha256,capturedAt:pinned?.capturedAt??new Date().toISOString()});
      } catch(error) { failures.push({...ref,error:String(error)}); }
    }
  }));
  results.sort((a,b)=>a.path.localeCompare(b.path));
  const report = {version:1,scope:'Literal /images/ references in assembled official JS/CSS/HTML; excludes dynamic URL construction',generatedAt:new Date().toISOString(),assets:results,failures};
  if(capture) await fs.writeFile(manifestFile,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({references:refs.length,verified:results.length,bytes:results.reduce((n,r)=>n+r.bytes,0),failures}));
  if(failures.some(r => !r.knownUnavailable)) throw Error(failures.length+' official static assets could not be prepared');
  return report;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await prepareStaticImages({root:path.resolve(process.argv.find(a=>a.startsWith('--root='))?.slice(7)??'build/official-ui'),capture:process.argv.includes('--capture')});
