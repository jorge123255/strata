/** Python is only a bootstrap: a pinned private Node/npm installation never changes the server runtime. */
export const BOT_NODE_VERSION = '24.12.0';
export const BOT_NODE_ARCHIVES = {
  'linux-x64': '6159227e0af7d7c3c6bb2fa900452b04a6cb8841a702a79acc613209d70b04d0',
  'linux-arm64': '9b2a2eeb98a8eb37361224e2a1d060300ad2dd143af58dfdb16de785df0f1228',
  'darwin-arm64': '319f221adc5e44ff0ed57e8a441b2284f02b8dc6fc87b8eb92a6a93643fd8080',
  'darwin-x64': 'b82ea4c62fd08e250cab59d625e75d77cc5b0a3d60c6698ebee4545c88a169c5',
};
export function pythonBootstrap(nodeSource) { return String.raw`
import os,sys,json,pathlib,platform,shutil,subprocess,urllib.request,hashlib,tarfile,tempfile,time,threading,signal,base64,queue
VERSION='24.12.0'
HASHES=json.loads(${JSON.stringify(JSON.stringify(BOT_NODE_ARCHIVES))})
NODE_SOURCE=base64.b64decode('${Buffer.from(nodeSource).toString('base64')}').decode()
cancelled=threading.Event()
def send(value): print(json.dumps(value),flush=True)
def private_path(parts):
 p=pathlib.Path.home()
 for part in parts:
  p=p/part;p.mkdir(mode=0o700,exist_ok=True)
  s=p.lstat()
  if p.is_symlink() or not p.is_dir() or s.st_uid!=os.getuid():raise ValueError('Bots needs an owned private helper directory.')
 p.chmod(0o700);return p
def active_runs():
 p=pathlib.Path.home()/'.local/share/strata/bot-workers/state/runs'
 if not p.exists():return 0
 count=0
 for f in list(p.iterdir())[:10000]:
  if not f.name.endswith('.json'):continue
  try:
   if f.is_symlink() or f.stat().st_size>4096:return None
   row=json.loads(f.read_text());pid=row.get('pid')
   if not isinstance(pid,int) or pid<1:return None
   try:os.kill(pid,0);count+=1
   except ProcessLookupError:pass
   except PermissionError:count+=1
  except:return None
 return count
def version_ok(node):
 try:
  v=subprocess.check_output([str(node),'--version'],stderr=subprocess.DEVNULL,timeout=4).decode().strip().lstrip('v').split('.')
  return int(v[0])>24 or int(v[0])==24 and int(v[1])>=12
 except:return False
def install_node(target,digest):
 base=private_path(['.local','share','strata','bot-runtimes']);dest=base/('node-v'+VERSION+'-'+target)
 if dest.exists():
  if dest.is_symlink() or not version_ok(dest/'bin/node'):raise ValueError('The private Bots Node runtime changed. Existing files were preserved.')
  return dest/'bin/node'
 stage=pathlib.Path(tempfile.mkdtemp(prefix='.prepare-',dir=base));stage.chmod(0o700)
 try:
  archive=stage/'node.tar.gz';url='https://nodejs.org/dist/v'+VERSION+'/node-v'+VERSION+'-'+target+'.tar.gz'
  sha=hashlib.sha256();size=0;began=time.monotonic()
  with urllib.request.urlopen(url,timeout=45) as response,open(archive,'xb') as output:
   os.chmod(archive,0o600)
   if not response.geturl().startswith('https://nodejs.org/'):raise ValueError('Unexpected Node download address.')
   while True:
    if cancelled.is_set():raise ValueError('Remote Bots preparation was cancelled.')
    chunk=response.read(1024*1024)
    if not chunk:break
    size+=len(chunk)
    if size>160*1024*1024 or time.monotonic()-began>240:raise ValueError('The private Node download exceeded its limit.')
    sha.update(chunk);output.write(chunk)
  if sha.hexdigest()!=digest:raise ValueError('The private Node archive failed SHA-256 verification. Nothing was installed.')
  if cancelled.is_set():raise ValueError('Remote Bots preparation was cancelled.')
  prefix='node-v'+VERSION+'-'+target;total=0
  with tarfile.open(archive,'r:gz') as tar:
   members=tar.getmembers();links={m.name for m in members if m.issym() or m.islnk()}
   for m in members:
    p=pathlib.PurePosixPath(m.name)
    if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!=prefix or any(str(a) in links for a in p.parents):raise ValueError('Unsafe path in the Node archive.')
    total+=max(0,m.size)
    if total>800*1024*1024 or not(m.isdir() or m.isfile() or m.issym() or m.islnk()):raise ValueError('Unsafe entry in the Node archive.')
    if m.issym() or m.islnk():
     target_path=pathlib.PurePosixPath(m.linkname)
     resolved=os.path.normpath(str(p.parent/target_path) if m.issym() else str(target_path))
     if target_path.is_absolute() or not resolved.startswith(prefix+'/'):raise ValueError('Unsafe link in the Node archive.')
   # The archive digest and every path/link have been checked before extraction.
   for m in members:
    if cancelled.is_set():raise ValueError('Remote Bots preparation was cancelled.')
    tar.extract(m,path=stage,set_attrs=False)
  runtime=stage/prefix
  for p in runtime.rglob('*'):
   if cancelled.is_set():raise ValueError('Remote Bots preparation was cancelled.')
   if p.is_symlink():continue
   p.chmod(0o700 if p.is_dir() or p.name=='node' else 0o600)
  # npm's executable wrappers need their recorded executable bit; Node executes npm-cli directly via PATH.
  for name in ['npm-cli.js','npx-cli.js']:
   p=runtime/'lib/node_modules/npm/bin'/name
   if p.exists():p.chmod(0o700)
  if not version_ok(runtime/'bin/node'):raise ValueError('The downloaded Node runtime did not start.')
  if cancelled.is_set():raise ValueError('Remote Bots preparation was cancelled.')
  os.rename(runtime,dest);return dest/'bin/node'
 finally:shutil.rmtree(stage,ignore_errors=True)
try:
 line=bytearray()
 while True:
  byte=os.read(0,1)
  if not byte:raise ValueError('The remote Bots request was empty.')
  line.extend(byte)
  if len(line)>16*1024*1024:raise ValueError('The remote Bots request exceeded its limit.')
  if byte==b'\n':break
 request=json.loads(line);system={'Linux':'linux','Darwin':'darwin'}.get(platform.system());arch={'x86_64':'x64','aarch64':'arm64','arm64':'arm64'}.get(platform.machine());target=(system or '')+'-'+(arch or '')
 controls=queue.Queue()
 def collect():
  pending=b''
  try:
   while True:
    data=os.read(0,65536)
    if not data:break
    controls.put(data);pending+=data
    if len(pending)>16*1024*1024:cancelled.set();break
    while b'\n' in pending:
     row,pending=pending.split(b'\n',1)
     try:
      if json.loads(row).get('type')=='cancel':cancelled.set()
     except:cancelled.set()
  except OSError:pass
  finally:
   if request.get('action')=='prepare':cancelled.set()
   controls.put(None)
 threading.Thread(target=collect,daemon=True).start()
 private=pathlib.Path.home()/'.local/share/strata/bot-runtimes'/('node-v'+VERSION+'-'+target)/'bin/node'
 candidates=[private,pathlib.Path.home()/'.local/bin/node',pathlib.Path.home()/'.grok/bin/node',shutil.which('node'),'/opt/homebrew/bin/node','/usr/local/bin/node','/usr/bin/node']
 node=next((str(p) for p in candidates if p and version_ok(p)),None)
 if node is None and request.get('action')=='prepare':
  if target not in HASHES:raise ValueError('Private Bots runtime installation supports Linux and macOS on x64 or arm64.')
  node=str(install_node(target,HASHES[target]))
 if node is None:
  send({'type':'result','value':{'available':False,'prepared':False,'installable':target in HASHES,'activeRuns':active_runs(),'platform':system or platform.system(),'detail':'Prepare Bots to install a private verified Node.js runtime and worker dependencies on this account. System Node, models and serving processes will stay unchanged.'}});sys.exit(0)
 if request.get('action')=='prepare' and cancelled.is_set():raise ValueError('Remote Bots preparation was cancelled.')
 request['bootstrapActiveRuns']=active_runs();line=(json.dumps(request)+'\n').encode()
 env=dict(os.environ);env['PATH']=str(pathlib.Path(node).parent)+os.pathsep+str(pathlib.Path.home()/'.local/bin')+os.pathsep+str(pathlib.Path.home()/'.grok/bin')+os.pathsep+str(pathlib.Path.home()/'.kimi-code/bin')+os.pathsep+env.get('PATH','')
 child=subprocess.Popen([node,'-e',NODE_SOURCE],stdin=subprocess.PIPE,env=env)
 def stop(signum,frame):
  try:child.send_signal(signal.SIGTERM)
  except ProcessLookupError:pass
 signal.signal(signal.SIGHUP,stop);signal.signal(signal.SIGTERM,stop)
 child.stdin.write(line);child.stdin.flush()
 def forward():
  try:
   while True:
    data=controls.get()
    if data is None:break
    child.stdin.write(data);child.stdin.flush()
  except (BrokenPipeError,OSError):pass
  finally:
   try:child.stdin.close()
   except (BrokenPipeError,OSError):pass
 threading.Thread(target=forward,daemon=True).start();sys.exit(child.wait())
except Exception as error:
 send({'type':'failure','code':'ssh_bootstrap','beforeStart':True,'message':str(error)[:1500]});sys.exit(1)
`; }
