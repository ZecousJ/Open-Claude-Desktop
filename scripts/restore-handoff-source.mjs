import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'docs/handoff/source');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output'))
  throw Error('Usage: node scripts/restore-handoff-source.mjs [--output /path/archive.tar.gz]');
const output = args.length ? path.resolve(args[1]) : path.join(root, 'work/handoff-download', manifest.archive.name);
const hashFile = async (file) => {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
};
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
if (manifest.version !== 2 || manifest.encoding !== 'base64' || manifest.chunkBytes !== 524288 ||
    !Array.isArray(manifest.parts) || !manifest.parts.length ||
    !validDigest(manifest.archive.sha256) || !Number.isSafeInteger(manifest.archive.bytes) || manifest.archive.bytes <= 0 ||
    !validDigest(manifest.encoded?.sha256) || manifest.encoded.bytes !== 4 * Math.ceil(manifest.archive.bytes / 3) ||
    manifest.encoded.lineBreaks !== false)
  throw Error('Invalid handoff manifest');
const seen = new Set();
for (const [index, part] of manifest.parts.entries()) {
  if (typeof part.name !== 'string' || !/^[a-zA-Z0-9_.-]+[.]txt$/.test(part.name) ||
      seen.has(part.name) || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes % 4 !== 0 ||
      part.bytes > manifest.chunkBytes || (index < manifest.parts.length - 1 && part.bytes !== manifest.chunkBytes) ||
      !validDigest(part.sha256))
    throw Error('Invalid handoff part');
  seen.add(part.name);
}
if (manifest.parts.reduce((sum, part) => sum + part.bytes, 0) !== manifest.encoded.bytes)
  throw Error('Manifest byte counts do not agree');
const existing = await fs.lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (existing) {
  if (!existing.isFile()) throw Error('Output exists and is not a regular file: ' + output);
  const actual = await hashFile(output);
  if (actual.bytes !== manifest.archive.bytes || actual.sha256 !== manifest.archive.sha256)
    throw Error('Output already exists with different content; choose another --output path: ' + output);
  console.log(JSON.stringify({ output, ...actual, verified: true, reused: true }));
} else {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = output + '.' + randomUUID() + '.partial';
  const handle = await fs.open(temporary, 'wx', 0o600);
  const total = createHash('sha256');
  const encodedTotal = createHash('sha256');
  let written = 0;
  try {
    for (const [index, part] of manifest.parts.entries()) {
      const file = path.join(source, part.name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size !== part.bytes) throw Error('Part missing or wrong size: ' + part.name);
      const encoded = await fs.readFile(file);
      if (encoded.length !== part.bytes || createHash('sha256').update(encoded).digest('hex') !== part.sha256)
        throw Error('Part checksum mismatch: ' + part.name);
      const text = encoded.toString('utf8');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) ||
          (index < manifest.parts.length - 1 && text.includes('=')))
        throw Error('Invalid Base64 text: ' + part.name);
      const decoded = Buffer.from(text, 'base64');
      if (decoded.toString('base64') !== text) throw Error('Noncanonical Base64 text: ' + part.name);
      encodedTotal.update(encoded); total.update(decoded); written += decoded.length;
      await handle.writeFile(decoded);
    }
    if (encodedTotal.digest('hex') !== manifest.encoded.sha256)
      throw Error('Complete Base64 text checksum mismatch');
    if (written !== manifest.archive.bytes || total.digest('hex') !== manifest.archive.sha256)
      throw Error('Assembled archive checksum mismatch');
    await handle.sync();
    await handle.close();
    // A hard link creates the final name exclusively; never overwrite a file
    // another process created while this archive was being reconstructed.
    await fs.link(temporary, output);
    console.log(JSON.stringify({ output, bytes: written, sha256: manifest.archive.sha256, verified: true, reused: false }));
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
  }
}
