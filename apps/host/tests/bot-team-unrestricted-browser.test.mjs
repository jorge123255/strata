/** Actual team editor, isolated HTTP and saved fixtures; starts no model or computer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root=fileURLToPath(new URL('..',import.meta.url)), source=join(root,'src');
const executablePath=[process.env.STRATA_UI_BROWSER,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium'].find(path=>path&&existsSync(path));
test('actual team editor selects every member, saves continuous work and retains previous host compatibility',{skip:!executablePath,timeout:60000},async t=>{
  const bots=Array.from({length:15},(_,i)=>({id:`member_${i}`,name:`Teammate ${i+1}`,provider:'configured',model:'fixture',policy:'manual',capabilities:'both',instructions:'',workspace:'/fixture',execution:{kind:'local'},computerMode:'host',createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'}));
  const requests=[],errors=[],blocked=[],unexpected=[];
  const entry=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotTeamEditor}from${JSON.stringify(join(source,'screens/BotTeamEditor.tsx'))};function Harness(){const[capable,setCapable]=useState(true),[continuous,setContinuous]=useState(true),[open,setOpen]=useState(true),[saved,setSaved]=useState(null);return <><button onClick={()=>{setCapable(false);setContinuous(false);setOpen(true)}}>Older host</button><button onClick={()=>{setCapable(true);setContinuous(false);setOpen(true)}}>Previous host</button>{open?<BotTeamEditor key={String(capable)+String(continuous)} bots={${JSON.stringify(bots)}} unrestrictedSupported={capable} continuousSupported={continuous} instructionsSupported settingsSupported onClose={()=>setOpen(false)} onSaved={async team=>{setSaved(team);setOpen(false)}}/>:null}<pre data-testid="saved">{JSON.stringify(saved)}</pre></>}createRoot(document.getElementById('root')).render(<Harness/>);`;
  const {outputFiles}=await build({stdin:{contents:entry,resolveDir:source,loader:'tsx'},absWorkingDir:root,bundle:true,write:false,outfile:'harness.js',format:'iife',platform:'browser',jsx:'automatic',loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'inert-store',setup(builder){builder.onResolve({filter:/(?:^|\/)store$/},args=>args.importer.includes('/src/')?{path:'store',namespace:'fixture'}:undefined);builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const useStore=()=>({toasts:[]}),dismissActionError=()=>{},dismissToast=()=>{},holdToast=()=>{},releaseToast=()=>{};',loader:'js'}));}}]});
  const js=outputFiles.find(file=>file.path.endsWith('.js')).text;
  const css=['styles/kit/tokens.css','styles/kit/components.css','styles/app.css','screens/Bots.css'].map(path=>readFileSync(join(source,path),'utf8')).join('\n')+'\n'+outputFiles.find(file=>file.path.endsWith('.css')).text;
  const reply=(res,body,type='application/json')=>{res.writeHead(200,{'content-type':type});res.end(type==='application/json'?JSON.stringify(body):body)};
  const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://fixture').pathname;
    if(path==='/')return reply(res,'<!doctype html><html data-theme="dark" data-motion="reduced"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>','text/html');
    if(path==='/harness.js')return reply(res,js,'text/javascript');
    if(path==='/harness.css')return reply(res,css,'text/css');
    if(path==='/icons/sprite.svg')return reply(res,readFileSync(join(root,'public/icons/sprite.svg')),'image/svg+xml');
    if(path.startsWith('/fonts/'))return reply(res,readFileSync(join(root,'public',path)),'font/woff2');
    if(path==='/favicon.ico'){res.writeHead(204);return res.end()}
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):null;requests.push({method:req.method,path,body});
    if(path==='/api/bots/teams'&&req.method==='POST')return reply(res,{team:{id:'team_fixture',...body,revision:1}});
    unexpected.push(`${req.method} ${path}`);res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath,headless:true,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1320,height:1000}});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(blocked.push(route.request().url()),route.abort()));
  await page.goto(origin);let editor=page.getByRole('dialog',{name:'New team',exact:true});
  await editor.getByRole('textbox',{name:'Team name',exact:true}).fill('Everyone together');
  for(const bot of bots)await editor.getByRole('checkbox',{name:bot.name,exact:true}).check();
  assert.equal(await editor.getByRole('checkbox',{name:'Teammate 15',exact:true}).isEnabled(),true);
  await editor.getByText('All available teammates can work at once. Teammates sharing one desktop take turns controlling it.',{exact:true}).waitFor();
  await editor.getByText('Until finished or stopped. Team work has no automatic turn, time, depth or message-hop cutoff. Use Stop whenever you need to end it.',{exact:true}).waitFor();
  assert.equal(await editor.locator('summary').filter({hasText:'Work limits'}).count(),0);
  assert.equal(await editor.getByRole('spinbutton').count(),0);
  const evidence=process.env.STRATA_TEAM_UNRESTRICTED_EVIDENCE_DIR;
  if(evidence){mkdirSync(evidence,{recursive:true});await page.screenshot({path:join(evidence,'mac-unrestricted-team.png')})}
  await editor.getByRole('button',{name:'Create team',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.deepEqual(requests[0].body.memberIds,bots.map(bot=>bot.id));assert.equal(requests[0].body.limits.maxParallel,0);assert.equal(requests[0].body.coordinatorId,bots[0].id);assert.deepEqual(requests[0].body.limits,{maxParallel:0,maxDepth:0,maxHops:0,maxTurns:0,maxDurationMs:0});
  await page.getByRole('button',{name:'Previous host',exact:true}).click();editor=page.getByRole('dialog',{name:'New team',exact:true});
  await editor.getByRole('textbox',{name:'Team name',exact:true}).fill('Previous server');
  for(const bot of bots.slice(0,2))await editor.getByRole('checkbox',{name:bot.name,exact:true}).check();
  await editor.locator('summary').filter({hasText:'Work limits'}).click();await editor.getByText('Work turns',{exact:true}).waitFor();
  assert.equal(await editor.getByText('Parallel tasks',{exact:true}).count(),0);
  await editor.getByRole('button',{name:'Create team',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.equal(requests[1].body.limits.maxParallel,0);assert.equal(requests[1].body.limits.maxTurns,24);
  await page.getByRole('button',{name:'Older host',exact:true}).click();editor=page.getByRole('dialog',{name:'New team',exact:true});
  await editor.getByRole('textbox',{name:'Team name',exact:true}).fill('Older server');
  for(const bot of bots.slice(0,12))await editor.getByRole('checkbox',{name:bot.name,exact:true}).check();
  assert.equal(await editor.getByRole('checkbox',{name:'Teammate 13',exact:true}).isDisabled(),true);
  await editor.locator('summary').filter({hasText:'Work limits'}).click();await editor.getByText('Parallel tasks',{exact:true}).waitFor();
  await editor.getByRole('button',{name:'Create team',exact:true}).click();await editor.waitFor({state:'hidden'});
  assert.equal(requests[2].body.memberIds.length,12);assert.equal(requests[2].body.limits.maxParallel,2);
  assert.equal(requests.length,3);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(blocked,[]);
  if(evidence)writeFileSync(join(evidence,'browser-report.json'),JSON.stringify({passed:true,browserErrors:errors,pageErrors:errors,selectedMembers:15,unlimitedParallel:0,continuousLimits:requests[0].body.limits,previousLimits:requests[1].body.limits,legacyMembers:12,modelPrompts:0,computerActions:0,productionMutations:0,requests},null,2)+'\n');
});
