/** Static ESM linkage only: reads actual assembled modules; never executes vendor code. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
test('every host-owned helper and derived module links named imports to actual assembled exports',()=>{
 const root=path.resolve('build/official-ui/ui'),manifest=JSON.parse(fs.readFileSync('build/official-ui/manifest.json','utf8'));
 const files=new Set<string>();
 for(const [key,value] of Object.entries(manifest)){
  if(!key.startsWith('host')||!value||typeof value!=='object')continue;
  for(const row of (value as any).ownedFiles??[])files.add(path.resolve(root,row.file));
  for(const row of (value as any).modules??[])files.add(path.resolve(root,'assets/v1',row.file));
 }
 assert.ok(files.size>=5,'assembled host derivation manifest is required');
 const parsed=new Map<string,ts.SourceFile>(),exports=new Map<string,Set<string>>();
 const parse=(file:string)=>{let ast=parsed.get(file);if(!ast){assert.ok(file.startsWith(root+path.sep),'module must remain inside assembled root');ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);parsed.set(file,ast)}return ast};
 const exported=(file:string):Set<string>=>{
  if(exports.has(file))return exports.get(file)!;
  const names=new Set<string>();exports.set(file,names);
  for(const node of parse(file).statements){
   if(ts.isExportDeclaration(node)){
    if(node.exportClause){
     if(ts.isNamedExports(node.exportClause))for(const item of node.exportClause.elements)names.add(item.name.text);
     else names.add(node.exportClause.name.text);
    }else if(node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text.startsWith('.')){
     for(const name of exported(path.resolve(path.dirname(file),node.moduleSpecifier.text)))if(name!=='default')names.add(name);
    }
   }else if(ts.isExportAssignment(node))names.add('default');
   else if(ts.canHaveModifiers(node)&&ts.getModifiers(node)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)){
    if(ts.getModifiers(node)?.some(m=>m.kind===ts.SyntaxKind.DefaultKeyword))names.add('default');
    if(ts.isVariableStatement(node)){for(const d of node.declarationList.declarations)if(ts.isIdentifier(d.name))names.add(d.name.text)}
    else if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&node.name)names.add(node.name.text);
   }
  }
  return names;
 };
 let checked=0;const failures:string[]=[];
 for(const file of files)for(const node of parse(file).statements){
  if(!ts.isImportDeclaration(node)||!node.importClause||!ts.isStringLiteral(node.moduleSpecifier))continue;
  const spec=node.moduleSpecifier.text;if(!spec.startsWith('.')||!spec.endsWith('.js'))continue;
  const target=path.resolve(path.dirname(file),spec),names=exported(target),needed:string[]=[];
  if(node.importClause.name)needed.push('default');
  const bindings=node.importClause.namedBindings;
  if(bindings&&ts.isNamedImports(bindings))for(const item of bindings.elements)needed.push((item.propertyName??item.name).text);
  for(const name of needed){checked++;if(!names.has(name))failures.push('Missing export '+name+' from '+path.relative(root,target)+' imported by '+path.relative(root,file))}
 }
 assert.ok(checked>20,'real named imports must be checked');
 assert.deepEqual(failures,[]);
});
