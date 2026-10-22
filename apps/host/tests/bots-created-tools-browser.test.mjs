/** Actual tool library with an inert HTTP fixture. No commands, providers or owner data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url)), src = join(root, 'src');
const executablePath = [process.env.STRATA_UI_BROWSER, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium'].find(value => value && existsSync(value));
test('created tools require reviewed versions, separate enable and grants, and never run from the library', { skip: executablePath ? false : 'Installed Chromium required.', timeout: 90000 }, async t => {
  const at = '2026-10-21T12:00:00Z', schema = {type:'object',properties:{query:{type:'string',description:'A search phrase',maxLength:160}},required:['query'],additionalProperties:false};
  const digest = revision => revision.toString(16).padStart(64, '0');
  let tool = {id:'tool_fixture',name:'Inspect project',description:'Report project details from the selected workspace.',command:'printf \'%s\\n\' "$STRATA_TOOL_INPUT"',inputSchema:schema,timeoutSeconds:30,status:'draft',revision:1,digest:digest(1),botIds:[],teamIds:[],createdAt:at,updatedAt:at,provenance:{botId:'bot_ava',chatId:'s_fixture',turnId:'turn_fixture'}};
  let unchangedTool = {...tool,id:'tool_unchanged',name:'Unchanged enabled helper',status:'enabled',revision:7,digest:digest(7)};
  const tools = () => [...(deleted ? [] : [tool]), ...(created ? [created] : []), unchangedTool];
  let created = null, rejectGrant = false, deleted = false;
  const bots = [{id:'bot_ava',name:'Ava'},{id:'bot_bea',name:'Bea'}], teams = [{id:'team_project',name:'Project crew',memberIds:bots.map(bot => bot.id)}];
  const calls = [], unexpected = [], pageErrors = [], browserErrors = [], blocked = [];
  const entry = `import React from'react';import{createRoot}from'react-dom/client';import{BotCreatedToolsPanel}from ${JSON.stringify(join(src,'screens/BotCreatedTools.tsx'))};import ${JSON.stringify(join(src,'screens/Bots.css'))};createRoot(document.getElementById('root')).render(<main><BotCreatedToolsPanel bots={${JSON.stringify(bots)}} teams={${JSON.stringify(teams)}}/></main>);`;
  const {outputFiles} = await build({stdin:{contents:entry,resolveDir:src,loader:'tsx'},bundle:true,write:false,outfile:'fixture.js',format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},plugins:[{name:'inert-store',setup(builder){builder.onResolve({filter:/(?:^|\/)store$/},args=>args.importer.includes('/src/')?{path:'store',namespace:'fixture'}:undefined);builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const useStore=selector=>selector({});export const dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};',loader:'js'}));}}]});
  const script = outputFiles.find(file=>file.path.endsWith('.js')).text;
  const css = ['styles/kit/tokens.css','styles/kit/components.css','styles/app.css'].map(path=>readFileSync(join(src,path),'utf8')).join('\n')+'\n'+(outputFiles.find(file=>file.path.endsWith('.css'))?.text ?? '');
  const reply = (res, body, status=200, type='application/json') => {res.writeHead(status,{'content-type':type});res.end(type==='application/json'?JSON.stringify(body):body);};
  const server = http.createServer(async (req,res) => {
    try {
      const path = new URL(req.url,'http://fixture').pathname;
      if(path==='/') return reply(res,'<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',200,'text/html');
      if(path==='/fixture.js') return reply(res,script,200,'text/javascript');
      if(path==='/fixture.css') return reply(res,css,200,'text/css');
      if(path==='/icons/sprite.svg') return reply(res,readFileSync(join(root,'public/icons/sprite.svg')),200,'image/svg+xml');
      if(path.startsWith('/fonts/') && existsSync(join(root,'public',path))) return reply(res,readFileSync(join(root,'public',path)),200,'font/woff2');
      if(path==='/favicon.ico'){res.writeHead(204);return res.end();}
      let raw='';for await(const chunk of req) raw+=chunk;const body=raw?JSON.parse(raw):undefined;calls.push({path,method:req.method,body});
      if(path==='/api/bots/tools' && req.method==='GET') return reply(res,{tools:tools(),createdToolsSupported:true});
      if(path==='/api/bots/tools' && req.method==='POST') {assert.deepEqual(Object.keys(body).sort(),['command','description','inputSchema','name','timeoutSeconds']);created={...body,id:'tool_created',status:'draft',revision:1,digest:digest(1),botIds:[],teamIds:[],createdAt:at,updatedAt:at};return reply(res,{tool:created},201);}
      if(path===`/api/bots/tools/${tool.id}` && req.method==='PATCH') {
        assert.equal(body.expectedRevision,tool.revision);assert.equal(body.expectedDigest,tool.digest);
        if(rejectGrant){rejectGrant=false;tool={...tool,name:'Inspect project · revised elsewhere',revision:tool.revision+1,digest:digest(tool.revision+1)};return reply(res,{error:'This tool changed on another device. Review the latest version.'},409);}
        const {expectedRevision,expectedDigest,...patch}=body;
        tool={...tool,...patch,revision:tool.revision+1,digest:digest(tool.revision+1),...(Object.hasOwn(patch,'command')?{status:'draft'}:{})};return reply(res,{tool});
      }
      if(path===`/api/bots/tools/${tool.id}` && req.method==='DELETE') {assert.deepEqual(body,{expectedRevision:tool.revision,expectedDigest:tool.digest});deleted=true;return reply(res,{removed:true});}
      if(path===`/api/bots/tools/${unchangedTool.id}` && req.method==='PATCH') {assert.equal(body.expectedRevision,unchangedTool.revision);assert.equal(body.expectedDigest,unchangedTool.digest);assert.equal(body.command,unchangedTool.command);assert.equal(body.status,'draft');unchangedTool={...unchangedTool,status:body.status,revision:unchangedTool.revision+1,digest:digest(unchangedTool.revision+1)};return reply(res,{tool:unchangedTool});}
      unexpected.push(req.method+' '+path);return reply(res,{error:'Unexpected fixture operation'},404);
    } catch(error){unexpected.push(error.message);return reply(res,{error:error.message},500);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath,headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:1000},colorScheme:'dark'});page.setDefaultTimeout(10000);
  page.on('pageerror',error=>pageErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')browserErrors.push(message.text());});
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()));
  const mutations=()=>calls.filter(call=>call.method!=='GET');
  const evidence=process.env.STRATA_CREATED_TOOLS_EVIDENCE_DIR;if(evidence)mkdirSync(evidence,{recursive:true});
  await page.goto(origin);await page.getByRole('heading',{name:'Inspect project',exact:true}).waitFor();
  assert.equal(mutations().length,0);
  await page.getByRole('button',{name:'New tool',exact:true}).click();let dialog=page.getByRole('dialog');
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Fixture helper');await dialog.getByRole('textbox',{name:'Purpose',exact:true}).fill('A reusable fixture command.');await dialog.getByRole('textbox',{name:'Command',exact:true}).fill('printf \'%s\' "$STRATA_TOOL_INPUT"');
  await dialog.getByRole('textbox',{name:'Input schema · JSON',exact:true}).fill('{bad JSON');await dialog.getByRole('button',{name:'Save draft',exact:true}).click();await dialog.getByText('Enter a JSON object schema with type "object".',{exact:true}).waitFor();assert.equal(mutations().length,0,'Invalid input never saves or executes.');
  await dialog.getByRole('textbox',{name:'Input schema · JSON',exact:true}).fill(JSON.stringify(schema));await dialog.getByRole('spinbutton',{name:'Timeout · seconds',exact:true}).fill('45');await dialog.getByRole('button',{name:'Save draft',exact:true}).click();await dialog.waitFor({state:'hidden'});
  assert.equal(mutations().length,1);assert.deepEqual(created.inputSchema,schema);assert.equal(created.status,'draft');assert.deepEqual(created.botIds,[]);assert.deepEqual(created.teamIds,[]);
  await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Inspect project',exact:true})}).getByRole('button',{name:'Review tool',exact:true}).click();dialog=page.getByRole('dialog');
  await dialog.getByText('Built by Ava',{exact:true}).waitFor();assert.equal(mutations().length,1,'Reviewing never runs or publishes a tool.');assert.equal(await dialog.getByRole('checkbox',{name:'Ava',exact:true}).isDisabled(),true);assert.equal(await dialog.getByRole('button',{name:'Save tool access',exact:true}).isDisabled(),true);
  if(evidence)await page.screenshot({path:join(evidence,'tool-draft-review-dark.png')});
  await dialog.getByRole('button',{name:'Enable reviewed tool',exact:true}).click();await dialog.getByRole('button',{name:'Revoke tool',exact:true}).waitFor();
  assert.deepEqual(mutations()[1].body,{status:'enabled',expectedRevision:1,expectedDigest:digest(1)});assert.deepEqual(tool.botIds,[],'Enabling grants no bot access.');
  await dialog.getByRole('checkbox',{name:'Ava',exact:true}).check();await dialog.getByRole('checkbox',{name:'Project crew',exact:true}).check();await dialog.getByRole('button',{name:'Save tool access',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[role="dialog"]')?.textContent.includes('Revision 3'));assert.deepEqual(mutations()[2].body,{botIds:['bot_ava'],teamIds:['team_project'],expectedRevision:2,expectedDigest:digest(2)});
  rejectGrant=true;await dialog.getByRole('checkbox',{name:'Bea',exact:true}).check();await dialog.getByRole('button',{name:'Save tool access',exact:true}).click();await dialog.getByText('This tool changed. Reload and review its current version before saving.',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'Revoke tool',exact:true}).isDisabled(),true);assert.equal(await dialog.getByRole('button',{name:'Save tool access',exact:true}).isDisabled(),true);assert.deepEqual(tool.botIds,['bot_ava'],'A stale grant cannot change access.');
  await dialog.getByRole('button',{name:'Review latest version',exact:true}).click();await dialog.getByText('Revision 4',{exact:true}).waitFor();assert.equal(await dialog.getByRole('checkbox',{name:'Bea',exact:true}).isChecked(),false,'Reviewing the new version discards the stale grant edit.');
  await page.setViewportSize({width:390,height:844});if(evidence)await page.screenshot({path:join(evidence,'tool-enabled-review-compact.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Tool review fits narrow windows.');
  await dialog.getByRole('button',{name:'Revoke tool',exact:true}).click();await dialog.getByRole('button',{name:'Enable reviewed tool',exact:true}).waitFor();assert.equal(tool.status,'draft');assert.deepEqual(mutations().at(-1).body,{status:'draft',expectedRevision:4,expectedDigest:digest(4)});
  await dialog.getByRole('button',{name:'Edit draft',exact:true}).click();await page.getByRole('dialog').getByRole('textbox',{name:'Command',exact:true}).fill('printf \'fixture revised\'');await page.getByRole('dialog').getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(tool.status,'draft');assert.equal(tool.command,'printf \'fixture revised\'');assert.equal(mutations().at(-1).body.expectedRevision,5);assert.equal(mutations().at(-1).body.expectedDigest,digest(5));
  await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Inspect project · revised elsewhere',exact:true})}).getByRole('button',{name:'Review tool',exact:true}).click();dialog=page.getByRole('dialog');const beforeDelete=mutations().length;
  await dialog.getByRole('button',{name:'Delete tool…',exact:true}).click();assert.equal(mutations().length,beforeDelete,'Opening delete confirmation does not remove a tool.');await dialog.getByRole('button',{name:'Keep tool',exact:true}).click();assert.equal(mutations().length,beforeDelete,'Cancelling deletion keeps the tool.');
  await dialog.getByRole('button',{name:'Delete tool…',exact:true}).click();await dialog.getByRole('button',{name:'Delete tool',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('heading',{name:'Inspect project · revised elsewhere',exact:true}).waitFor({state:'hidden'});assert.equal(deleted,true);assert.deepEqual(mutations().at(-1),{path:'/api/bots/tools/tool_fixture',method:'DELETE',body:{expectedRevision:6,expectedDigest:digest(6)}});
  await page.getByRole('article').filter({has:page.getByRole('heading',{name:'Unchanged enabled helper',exact:true})}).getByRole('button',{name:'Review tool',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Edit draft',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Save draft',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(unchangedTool.status,'draft','Saving an unchanged enabled tool as a draft must explicitly revoke its enabled state.');assert.equal(mutations().at(-1).body.status,'draft');assert.equal(mutations().at(-1).body.expectedRevision,7);assert.equal(mutations().at(-1).body.expectedDigest,digest(7));
  assert.ok(mutations().every(call=>['/api/bots/tools','/api/bots/tools/tool_fixture','/api/bots/tools/tool_unchanged'].includes(call.path)),'All writes only save library configuration.');assert.deepEqual(unexpected,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(browserErrors,['Failed to load resource: the server responded with a status of 409 (Conflict)'],'The deliberate stale-version response is the only console error.');assert.deepEqual(blocked,[]);
  if(evidence)writeFileSync(join(evidence,'browser-report.json'),JSON.stringify({passed:true,scope:'Actual Tools library in Chromium with inert HTTP, no commands or owner traffic',commandsExecuted:0,modelPrompts:0,ownerMutations:0,calls,pageErrors,browserErrors:[],expectedConsoleErrors:browserErrors,screenshots:['tool-draft-review-dark.png','tool-enabled-review-compact.png']},null,2)+'\n');
});
