/** Sent verbatim to the remote Node process. No connection, model or workspace text enters this code. */
import { pythonBootstrap } from './bots-ssh-python.mjs';
export const bootstrapSource = String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process'),rl=require('node:readline');
const send=o=>process.stdout.write(JSON.stringify(o)+'\n');
const MAX=16*1024*1024;let partial=0,workerStarted=false;process.stdin.on('data',chunk=>{for(const byte of chunk){partial=byte===10?0:partial+1;if(partial>MAX){send({type:'failure',code:'ssh_protocol_limit',beforeStart:!workerStarted,message:'Remote Bots request exceeded its size limit.'});process.exit(1);}}});
const reader=rl.createInterface({input:process.stdin,crlfDelay:Infinity});
const managed=new Set();let managementCancelled=false,managementDone=false,action;
const stopped=new WeakMap();function stopGroup(child){if(stopped.has(child))return stopped.get(child);const alive=()=>{try{process.kill(-child.pid,0);return true;}catch(e){return e.code!=='ESRCH';}};const promise=(async()=>{if(!alive())return;try{process.kill(-child.pid,'SIGTERM');}catch{}const began=Date.now();let killed=false;while(alive()){if(!killed&&Date.now()-began>=1000){try{process.kill(-child.pid,'SIGKILL');}catch{}killed=true;}if(Date.now()-began>3000)throw Error('Could not confirm remote installer process cleanup.');await new Promise(r=>setTimeout(r,20));}})();promise.catch(()=>{});stopped.set(child,promise);return promise;}
function stopManaged(){managementCancelled=true;for(const child of managed)void stopGroup(child);}
process.once('SIGHUP',stopManaged);process.once('SIGTERM',stopManaged);
reader.on('line',line=>{try{if(JSON.parse(line).type==='cancel'&&action==='prepare')stopManaged();}catch{}});reader.on('close',()=>{if(action==='prepare'&&!managementDone)stopManaged();});
const first=new Promise((resolve,reject)=>{reader.once('line',line=>{try{resolve(JSON.parse(line));}catch{reject(Error('Invalid remote Bots request.'));}});reader.once('close',()=>reject(Error('Remote Bots request was empty.')));});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function privateRoot(){let folder=os.homedir();for(const part of ['.local','share','strata','bot-workers']){folder=path.join(folder,part);try{await fs.mkdir(folder,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}const s=await fs.lstat(folder);if(!s.isDirectory()||s.isSymbolicLink()||(process.getuid&&s.uid!==process.getuid()))throw Error('Remote Bots requires an owned private helper folder.');}await fs.chmod(folder,0o700);return folder;}
async function installed(root,request){try{const marker=JSON.parse(await fs.readFile(path.join(root,request.hash,'.prepared.json'),'utf8'));if(marker.hash!==request.hash)return false;for(const [name,digest] of request.files??[]){if(!/^[a-zA-Z0-9_./-]+$/.test(name)||name.split('/').includes('..'))return false;const p=path.join(root,request.hash,name),s=await fs.lstat(p);if(s.isSymbolicLink()||!s.isFile()||hash(await fs.readFile(p))!==digest)return false;}for(const[name,version]of Object.entries(request.dependencies??{})){const p=JSON.parse(await fs.readFile(path.join(root,request.hash,'node_modules',...name.split('/'),'package.json'),'utf8'));if(p.version!==version)return false;}return true;}catch{return false;}}
async function command(command,args,cwd,timeout){if(managementCancelled)throw Error('Remote Bots preparation was cancelled.');return await new Promise((resolve,reject)=>{const child=cp.spawn(command,args,{cwd,env:{...process.env,PATH:path.dirname(process.execPath)+path.delimiter+(process.env.PATH??''),PLAYWRIGHT_BROWSERS_PATH:path.join(cwd,'browsers'),NPM_CONFIG_CACHE:path.join(cwd,'.npm-cache')},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});managed.add(child);let size=0,forced;const timer=setTimeout(()=>{forced='Remote Bots dependency installation timed out.';void stopGroup(child);},timeout);const collect=c=>{size+=c.length;if(size>1024*1024&&!forced){forced='Remote Bots dependency installation returned too much output.';void stopGroup(child);}};child.stdout.on('data',collect);child.stderr.on('data',collect);child.on('error',()=>{managed.delete(child);clearTimeout(timer);reject(Error('The private Bots runtime could not start npm.'));});child.on('close',async code=>{clearTimeout(timer);try{await stopGroup(child);code===0&&!managementCancelled&&!forced?resolve():reject(Error(forced??(managementCancelled?'Remote Bots preparation was cancelled.':'Remote Bots dependencies could not be installed. Check npm registry access on that computer.')));}catch(e){reject(e);}finally{managed.delete(child);}});});}
(async()=>{const request=await first;action=request.action;
 const v=process.versions.node.split('.').map(Number),nodeOK=v[0]>24||v[0]===24&&v[1]>=12;
 if(!nodeOK){send({type:'result',value:{available:false,prepared:false,platform:process.platform,nodeVersion:process.versions.node,detail:'Install Node.js 24.12 or newer on this SSH computer first.'}});reader.close();return;}
 if(!/^[a-f0-9]{64}$/.test(request.hash??''))throw Error('Invalid remote Bots worker version.');
 const base=path.join(os.homedir(),'.local','share','strata','bot-workers');
 const valid=await installed(base,request);
 if(request.action==='probe'&&!valid){send({type:'result',value:{available:false,prepared:false,activeRuns:request.bootstrapActiveRuns,platform:process.platform,nodeVersion:process.versions.node,detail:'Prepare Bots on this SSH computer to install its private worker dependencies.'}});reader.close();return;}
 if(request.action==='prepare'){
  const root=await privateRoot(),target=path.join(root,request.hash);
  if(!valid){if(await fs.lstat(target).then(()=>true,()=>false))throw Error('This worker version is incomplete or changed. Its existing files were preserved; repair the private worker before preparing it again.');
   const stage=await fs.mkdtemp(path.join(root,'.prepare-'));await fs.chmod(stage,0o700);
   try{const entries=Object.entries(request.assets??{});if(!entries.length||entries.length>40)throw Error('Invalid worker assets.');let bytes=0;
    for(const[name,encoded]of entries){if(!/^[a-zA-Z0-9_./-]+$/.test(name)||name.split('/').includes('..')||path.isAbsolute(name))throw Error('Invalid worker asset name.');const content=Buffer.from(encoded,'base64');bytes+=content.length;if(bytes>2*1024*1024||hash(content)!==(request.files??[]).find(f=>f[0]===name)?.[1])throw Error('Worker asset verification failed.');const file=path.join(stage,name);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,content,{mode:0o600,flag:'wx'});}
    await command('npm',['ci','--omit=dev','--omit=optional','--ignore-scripts','--no-audit','--no-fund'],stage,240000);
    if(managementCancelled)throw Error('Remote Bots preparation was cancelled.');await fs.writeFile(path.join(stage,'.prepared.json'),JSON.stringify({hash:request.hash,preparedAt:new Date().toISOString()}),{mode:0o600});await fs.rename(stage,target);
   }finally{await fs.rm(stage,{recursive:true,force:true});}
  }
  if(request.installBrowser===true){await command(process.execPath,[path.join(target,'node_modules','playwright-core','cli.js'),'install','chromium'],target,240000);}
 }
 if(!['run','probe','prepare','computer','host-folder'].includes(request.action))throw Error('Unsupported remote Bots action.');
 if(!await installed(base,request))throw Error('Prepare this exact version of Bots on the SSH computer first.');
 process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(base,request.hash,'browsers');
 if(request.action==='host-folder'){workerStarted=true;send({type:'worker-ready'});const folder=await import(require('node:url').pathToFileURL(path.join(base,request.hash,'server','bots-host-folder-worker.mjs')).href);await folder.hostFolderOperation(request.input,{reader,send,directory:path.join(base,'state'),leaseMs:12000});return;}
 const worker=await import(require('node:url').pathToFileURL(path.join(base,request.hash,'server','bots-runtime','ssh-worker.mjs')).href);
 if(request.action==='run'||request.action==='computer'){workerStarted=true;send({type:'worker-ready'});await worker[request.action==='run'?'startWorker':'computerOperation'](request.input,{reader,send,directory:path.join(base,'state'),bundleRoot:path.join(base,request.hash),leaseMs:12000});}
 else{const value=await worker.probeWorker({directory:path.join(base,'state'),bundleRoot:path.join(base,request.hash)});managementDone=true;send({type:'result',value:{...value,available:true,prepared:true,workerVersion:request.hash}});reader.close();}
})().catch(error=>{send({type:'failure',code:'ssh_worker',beforeStart:!workerStarted,message:String(error?.message??error).replace(/Bearer\s+[\w.-]+/gi,'Bearer [redacted]').slice(0,1500)});reader.close();process.exitCode=1;});
`;

const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`;
// Only fixed, reviewed program text reaches the remote shell. Everything selected in the app goes over stdin.
export const SSH_BOTS_COMMAND = `exec python3 -c ${shellQuote(pythonBootstrap(bootstrapSource))}`;
