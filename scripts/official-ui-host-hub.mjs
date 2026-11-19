/** Offline resource-location repair for the single already-delivered Hub module.
 * Descriptor presence is NOT account authorization. No feature, permission,
 * remote-service check, or original archive is changed by this derivation.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const pins = JSON.parse(fs.readFileSync(new URL('./official-host/hub-resources.json',import.meta.url),'utf8'));
export const hostHubResources = Object.freeze(pins);
export const hostHubRevision = pins.revision;
const sha = value => createHash('sha256').update(value).digest('hex');
export const hostHubRule = 'existing-empty-hub-descriptor-pinned-local-resource';
const anchor = '      n = t && zj(t);';
// The descriptor is deliberately NOT a source of any pathname or preload URL.
// Nonempty upstream descriptors and every other gate retain their original path.
export const localHubResolverSource = `function __claudexLocalHubResource(name, descriptor, moduleUrl) {
  if (name !== ${JSON.stringify(pins.gate)} || !descriptor ||
      descriptor.secret !== "" || descriptor.hash !== ${JSON.stringify(pins.descriptorHash)} ||
      descriptor.body !== ${JSON.stringify(pins.body)} ||
      !Array.isArray(descriptor.css) || descriptor.css.length !== 0) return undefined;
  return {entry: new URL(${JSON.stringify('./'+pins.localEntry)}, moduleUrl).href,
    body: new URL(${JSON.stringify('./'+pins.body)}, moduleUrl).href,
    preload: [], alsoFetch: []};
}\n`;
export function deriveOfficialUiHostHubModule(name, source) {
  if (name !== pins.loader) return source;
  if (sha(source) !== pins.loaderSha256) throw Error('Pinned Hub loader checksum mismatch');
  if (source.split(anchor).length !== 2) throw Error('Pinned Hub loader anchor mismatch');
  return localHubResolverSource + source.replace(anchor,
    '      n = t && (__claudexLocalHubResource(e, t, import.meta.url) ?? zj(t));');
}
export function inspectPinnedHubResources(directory) {
  if(fs.lstatSync(directory).isSymbolicLink()) throw Error('Hub resource directory symlink rejected');
  const rows=[]; let entry;
  for(const file of fs.readdirSync(directory).sort()) {
    const target=path.join(directory,file), stat=fs.lstatSync(target);
    if(stat.isSymbolicLink() || !stat.isFile()) throw Error('Hub resource non-file rejected');
    if(file.endsWith('.map')) continue;
    const bytes=fs.readFileSync(target), digest=sha(bytes);
    rows.push({file,bytes:bytes.length,sha256:digest});
    if(digest===pins.entrySha256) {
      if(entry) throw Error('Duplicate pinned Hub entry');
      entry=bytes;
    }
  }
  // Pin the entire supplied static catalogue, a strict superset of Hub dependencies.
  // The digest covers sorted names, byte counts and SHA256, never personal secrets.
  if(rows.length!==pins.catalogueFiles || sha(JSON.stringify(rows))!==pins.catalogueSha256)
    throw Error('Pinned Hub resource catalogue mismatch');
  if(!entry || rows.find(row=>row.file===pins.body)?.sha256!==pins.bodySha256)
    throw Error('Pinned Hub entry or body missing');
  return {entry, catalogueFiles: rows.length, catalogueSha256:pins.catalogueSha256};
}
export function hostHubManifest() {
  return {revision:pins.revision,gate:pins.gate,rule:hostHubRule,
    catalogueFiles:pins.catalogueFiles,catalogueSha256:pins.catalogueSha256,
    entry:{file:'assets/v1/'+pins.localEntry,sha256:pins.entrySha256},
    body:{file:'assets/v1/'+pins.body,sha256:pins.bodySha256},
    loader:{file:pins.loader,originalSha256:pins.loaderSha256}};
}
export function applyOfficialUiHostHub(directory) {
  const real=fs.realpathSync(directory);
  if(real.split(path.sep).includes('.restore')) throw Error('Recovered sources are immutable');
  const {entry}=inspectPinnedHubResources(directory);
  const target=path.join(directory,pins.loader), original=fs.readFileSync(target,'utf8');
  const derived=deriveOfficialUiHostHubModule(pins.loader,original);
  const alias=path.join(directory,pins.localEntry);
  if(fs.existsSync(alias)) throw Error('Hub alias already exists');
  fs.writeFileSync(alias,entry,{flag:'wx'});
  fs.writeFileSync(target,derived);
  return {...hostHubManifest(),loader:{...hostHubManifest().loader,outputSha256:sha(derived)}};
}
