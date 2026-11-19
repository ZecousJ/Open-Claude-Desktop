/** Build only Claudex-owned Activity source against the existing pinned React instance. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
export const usageActivityBundleRevision = 'claudex-owned-usage-activity-v1';
const vendor='./vendor-frame-iz8L1jC9.js';
export async function buildOfficialUsageActivity(outputDirectory) {
  const out=path.resolve(outputDirectory);
  if (out.split(path.sep).includes('.restore')) throw Error('Recovered sources are immutable');
  fs.mkdirSync(out,{recursive:true});
  const result=await build({
    entryPoints:{'claudex-usage-activity':'scripts/official-host/usage-activity-entry.tsx'},outdir:out,
    bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',jsx:'automatic',minify:true,metafile:true,
    chunkNames:'claudex-usage-[name]-[hash]',assetNames:'claudex-usage-[name]-[hash]',loader:{'.woff2':'file','.woff':'file','.svg':'text'},
    plugins:[{name:'same-official-react',setup(b){
      b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},({path:p})=>({path:p,namespace:'official-react'}));
      b.onLoad({filter:/.*/,namespace:'official-react'},({path:p})=>({loader:'js',contents:p==='react'
        ? `import {do as React} from '${vendor}'; export default React; export const {useState,useEffect,useRef,useMemo,useCallback,useLayoutEffect,useSyncExternalStore,forwardRef,createElement,Fragment}=React;`
        : `import {do as React,qa as jsx,Ja as jsxs} from '${vendor}'; export {jsx,jsxs}; export const Fragment=React.Fragment;`}));
      b.onResolve({filter:/^\.\/(?:vendor-frame-iz8L1jC9|vendor-intl-D9Num-b5|shared-l-p-m-w-2-BMCa56Vr|shared-1-B16QIYNI|shared-19-DSOWNXOA|shared-frame-DH1u5uQk|ce802b15a-CA_45z3b|c323610d7-C6-KSPO9|c17c9c40b-CQVGk63d)\.js$/},args=>({path:args.path,external:true}));
    }}],logLevel:'silent',
  });
  if(Object.keys(result.metafile.inputs).some(p=>p.includes('node_modules/react/'))) throw Error('Second React runtime rejected');
  const files=Object.keys(result.metafile.outputs).map(p=>path.resolve(p)).sort();
  const sources=Object.keys(result.metafile.inputs).filter(p=>!p.startsWith('official-react:')).sort();
  return {revision:usageActivityBundleRevision, sourceHashes:[...sources,'scripts/official-ui-usage-activity-bundle.mjs'].map(source=>({source,sha256:createHash('sha256').update(fs.readFileSync(source.replace(/\?raw$/, ''))).digest('hex')})),files:files.map(file=>({file:path.relative(out,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')})),sources:Object.keys(result.metafile.inputs).filter(p=>!p.startsWith('official-react:')).sort()};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if(process.argv.length!==3) throw Error('Expected one owned bundle output directory');
  console.log(JSON.stringify(await buildOfficialUsageActivity(process.argv[2])));
}
