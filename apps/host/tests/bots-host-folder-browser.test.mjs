/** Real folder settings component; disposable HTTP fixture, no owner host. */
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';import {chromium} from 'playwright-core';
const root=fileURLToPath(new URL('..',import.meta.url));
const executablePath=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium'].find(existsSync);
test('folder settings grant nothing on open, default to read only and explicitly remove with null', {skip:!executablePath,timeout:60000},async t=>{
 const bundle=await build({absWorkingDir:root,metafile:true,stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{BotHostFolderSettings}from ${JSON.stringify(join(root,'src/components/BotHostFolderSettings.tsx'))};let b={id:'bot_fixture',name:'Fixture',computerMode:'cua',execution:{kind:'ssh',host:'fixture.invalid',user:'fixture'},updatedAt:'fixture-version'};createRoot(document.getElementById('root')).render(<BotHostFolderSettings bot={b} onSaved={()=>window.saved=true}/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'out',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const js=bundle.outputFiles.find(file=>file.path.endsWith('.js')).text,requests=[];let reject=true;
 const server=http.createServer(async(req,res)=>{if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(js);}if(req.url==='/'){res.setHeader('content-type','text/html');return res.end('<html data-theme="dark"><style>body{background:#141619;color:#fff;font:16px system-ui;padding:30px;max-width:600px}input,button{font:inherit;padding:10px}p{line-height:1.5}.form-stack{display:grid;gap:16px}</style><div id="root"></div><script src="/bundle.js"></script>');}if(req.url==='/api/bots/bot_fixture/host-folder'){let body='';for await(const chunk of req)body+=chunk;requests.push({method:req.method,body:JSON.parse(body)});res.writeHead(reject?409:200,{'content-type':'application/json'});res.end(JSON.stringify(reject?{error:'Finish current work before changing access.'}:{saved:true}));return;}res.writeHead(404).end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({executablePath,headless:true});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const page=await browser.newPage({viewport:{width:800,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByLabel('Share a host folder',{exact:true}).waitFor();assert.equal(requests.length,0);
 await page.getByLabel('Share a host folder',{exact:true}).check();await page.getByLabel('Shared host folder path').fill('/srv/synthetic project');
 assert.equal(await page.getByRole('combobox',{name:'Shared host folder access'}).innerText(),'Read only');
 const evidence=process.env.STRATA_FOLDER_UI_EVIDENCE;if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:join(evidence,'mac-host-folder-read-only.png')});}
 await page.getByRole('button',{name:'Save folder access',exact:true}).click();await page.getByText('Finish current work before changing access.').waitFor();
 assert.deepEqual(requests[0],{method:'PUT',body:{expectedUpdatedAt:'fixture-version',hostFolder:{path:'/srv/synthetic project',access:'read'}}});
 reject=false;await page.getByRole('button',{name:'Save folder access',exact:true}).click();await page.getByText('Folder access saved.').waitFor();
 await page.getByLabel('Share a host folder',{exact:true}).uncheck();await page.getByRole('button',{name:'Remove folder access',exact:true}).click();await page.waitForFunction(()=>window.saved===true);
 await new Promise(r=>setTimeout(r,100));
 await new Promise(r=>setImmediate(r));assert.equal(requests.at(-1).body.hostFolder,null);assert.deepEqual(errors,[]);
 if(evidence){const hash=value=>createHash('sha256').update(value).digest('hex');const inputs=Object.fromEntries(Object.keys(bundle.metafile.inputs).filter(path=>path!=='<stdin>').map(path=>{const file=resolve(root,path);return[file,hash(readFileSync(file))];}));writeFileSync(join(evidence,'browser-report.json'),JSON.stringify({passed:true,browserErrors:errors,sourceInputsSHA256:inputs,checks:['No grant or work on opening','Read only default','Exact versioned PUT','Busy error is visible','Explicit successful save','Explicit null revocation'],testSHA256:hash(readFileSync(fileURLToPath(import.meta.url))),requests},null,2));}

});
