import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const storeURL=new URL('../server/bots-workflows-store.mjs',import.meta.url).href;
test('simultaneous disposable processes never both claim/save/dispatch through a stale checkpoint view',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'strata-workflow-writers-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));const barrier=join(directory,'go'),effects=join(directory,'effects');writeFileSync(effects,'0');
 const children=Array.from({length:6},(_,i)=>{const script=`import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {workflowStore} from ${JSON.stringify(storeURL)};const store=workflowStore(${JSON.stringify(directory)});store.read();writeFileSync(${JSON.stringify(join(directory,'ready-'))}+${i},'ready');while(!existsSync(${JSON.stringify(barrier)}))await new Promise(r=>setTimeout(r,2));try{store.save({version:1,winner:${i}});store.assertOwner();writeFileSync(${JSON.stringify(effects)},String(Number(readFileSync(${JSON.stringify(effects)},'utf8'))+1));await new Promise(r=>setTimeout(r,100));store.close();process.exit(0);}catch{store.close();process.exit(3);}`;const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'pipe'});return {child,done:new Promise((resolve,reject)=>{let error='';child.stderr.on('data',b=>error+=b);child.once('error',reject);child.once('close',code=>resolve({code,error}));})};});
 const started=Date.now();while(!children.every((_,i)=>existsSync(join(directory,'ready-'+i)))){if(Date.now()-started>8000)throw new Error('Children not ready');await new Promise(r=>setTimeout(r,2));}writeFileSync(barrier,'go');const results=await Promise.all(children.map(c=>c.done));assert.equal(results.every(r=>[0,3].includes(r.code)),true,JSON.stringify(results));const winners=results.filter(r=>r.code===0).length;assert.ok(winners<=1);assert.equal(Number(readFileSync(effects,'utf8')),winners);if(winners)assert.ok(Number.isInteger(JSON.parse(readFileSync(join(directory,'bot-workflows.json'))).winner));
});
