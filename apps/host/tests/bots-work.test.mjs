import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBotWork, botRoutineNext } from '../server/bots-work.mjs';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'strata-bot-work-')), id = 'bot_12345678-abcd', other = 'bot_87654321-abcd';
  let time = Date.parse('2026-10-20T15:00:00Z'), serial = 0, removed = false;
  const sent = [], chats = new Map(), settings = { id, policy: 'manual' };
  const options = { directory, requireBot: key => { if (removed || ![id,other].includes(key)) throw new Error('Bot removed'); return settings; }, now: () => time, tickMs: 0,
    chats: () => ({ list: () => ({ conversations: [...chats.values()] }), detail: key => ({ conversation: chats.get(key) }), send: (key,prompt) => { sent.push({key,prompt}); chats.get(key).active = true; } }),
    createConversation: key => { const conversation = { id: `chat_${++serial}`, active: false, preferences: { botId: key, mode: 'manual' }, messages: [] }; chats.set(conversation.id, conversation); return { conversation }; } };
  const work = createBotWork(options); t.after(() => { work.close(); rmSync(directory,{recursive:true,force:true}); });
  return { directory,id,other,work,options,sent,chats,settings,advance: ms => { time += ms; }, remove: () => { removed = true; } };
}
test('private memory and outputs persist without an independent conversation history', t => {
  const f = fixture(t); assert.equal(f.work.instructions(f.id), '');
  const result = f.work.update(f.id,{memory:'Prefer concise reports.',rules:[{id:'r1',action:'Make a purchase',behavior:'ask'}]});
  assert.equal(result.memory,'Prefer concise reports.'); assert.match(f.work.instructions(f.id), /Strata’s permission mode still applies/);
  f.work.putFile(f.id,{path:'outputs/report.md',content:'Verified result'});
  assert.deepEqual(f.work.getFile(f.id,'outputs/report.md'),{text:'Verified result'});
  assert.equal(f.work.list(f.other).outputs.length,0); assert.equal(f.sent.length,0);
  assert.equal(statSync(join(f.directory,'bot-volumes',f.id,'memory/MEMORY.md')).mode&0o777,0o600);
  const restored = createBotWork(f.options); assert.equal(restored.list(f.id).memory,'Prefer concise reports.'); restored.close();
});
test('notification routine projection contains only saved chat identity and explicit completion preference', t => {
  const f = fixture(t), routine = f.work.putRoutine(f.id, { title: 'PRIVATE_ROUTINE_TITLE', prompt: 'PRIVATE_PROMPT', notifyOnCompletion: true, schedule: { kind: 'every', minutes: 1 } });
  assert.deepEqual(f.work.notificationSources(), []);
  const result = f.work.runRoutine(f.id, routine.id);
  assert.deepEqual(f.work.notificationSources(), [{ chatId: result.conversation.id, notifyOnCompletion: true }]);
  assert.ok(!JSON.stringify(f.work.notificationSources()).includes('PRIVATE_'));
});
test('files reject traversal, outside namespaces and symlinks', t => {
  const f=fixture(t); f.work.putFile(f.id,{path:'outputs/test.txt',content:'Inside'});
  for(const path of ['../outside','outputs/../../outside','/outputs/a','outputs/../a','work.json','outputs/a\\b']) assert.throws(()=>f.work.putFile(f.id,{path,content:'Bad'}));
  symlinkSync('/tmp',join(f.directory,'bot-volumes',f.id,'outputs','escape'));
  assert.throws(()=>f.work.putFile(f.id,{path:'outputs/escape/bad',content:'Bad'}),/links/);
});
test('only completed approved write_file events mirror deliverables and memory', t => {
  const f=fixture(t), tool={name:'write_file',args:{path:'outputs/answer.md',content:'Done'}};
  for(const state of ['proposed','running','denied','error'])f.work.record(f.id,{type:'agent-tool',tool:{...tool,state}});
  assert.equal(f.work.list(f.id).outputs.length,0);
  f.work.record(f.id,{type:'agent-tool',tool:{...tool,state:'done'}}); assert.equal(f.work.list(f.id).outputs.length,1);
  f.work.record(f.id,{type:'agent-tool',tool:{name:'write_file',state:'done',args:{path:'memory/MEMORY.md',content:'Remembered'}}});
  assert.equal(f.work.list(f.id).memory,'Remembered');
});
test('routines start disabled and enabled schedules create shared Manual conversations without catch-up bursts', t => {
  const f=fixture(t), routine=f.work.putRoutine(f.id,{title:'Review',prompt:'Check the results',schedule:{kind:'every',minutes:1}});
  f.advance(3600000);f.work.tick();assert.equal(f.sent.length,0);
  f.work.putRoutine(f.id,{enabled:true},routine.id);f.advance(61000);f.work.tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].prompt,'Check the results');
  const chat=f.chats.get(f.sent[0].key);assert.equal(chat.preferences.botId,f.id);assert.equal(chat.preferences.mode,'manual');
  f.advance(3600000);f.work.tick();assert.equal(f.sent.length,1);
  chat.active=false;chat.messages.push({role:'assistant',content:'Complete'});f.work.tick();
  assert.equal(f.sent.length,2); // One due future interval, never a burst for the sixty missed intervals.
});
test('restart marks interrupted work and schedules future runs instead of replaying a prior task', t => {
  const f=fixture(t), routine=f.work.putRoutine(f.id,{title:'Review',prompt:'Check',enabled:true,schedule:{kind:'every',minutes:1}});
  f.work.runRoutine(f.id,routine.id);assert.equal(f.sent.length,1);
  const restored=createBotWork(f.options);restored.tick();assert.equal(f.sent.length,1);assert.equal(restored.list(f.id).routines[0].state,'interrupted');restored.close();
});
test('removing a bot disables its routines without removing memory or outputs', t => {
  const f=fixture(t), routine=f.work.putRoutine(f.id,{title:'Review',prompt:'Check',enabled:true,schedule:{kind:'every',minutes:1}});
  f.work.update(f.id,{memory:'Retained'});f.work.removed(f.id);f.remove();f.advance(120000);f.work.tick();assert.equal(f.sent.length,0);
  assert.equal(readFileSync(join(f.directory,'bot-volumes',f.id,'memory/MEMORY.md'),'utf8'),'Retained');
  const rows=JSON.parse(readFileSync(join(f.directory,'bot-volumes','routines.json'),'utf8'));assert.equal(rows.find(r=>r.id===routine.id).enabled,false);
});
test('daily and weekly schedules carry an explicit time zone and reject malformed intervals', () => {
  const after=Date.parse('2026-10-20T15:00:00Z');
  assert.equal(botRoutineNext({kind:'daily',hour:11,minute:0},after,'America/Chicago'),'2026-10-20T16:00:00.000Z');
  assert.equal(botRoutineNext({kind:'weekly',weekday:3,hour:11,minute:0},after,'America/Chicago'),'2026-10-21T16:00:00.000Z');
  for(const schedule of [{kind:'every',minutes:0},{kind:'daily',hour:24,minute:0},{kind:'weekly',weekday:9,hour:10,minute:0}])assert.throws(()=>botRoutineNext(schedule,after));
});
test('paused bots skip scheduled work and cannot be started manually; Resume never replays missed intervals', t => {
  const f = fixture(t), row = f.work.putRoutine(f.id, { title: 'Check', prompt: 'Review', enabled: true, schedule: { kind: 'every', minutes: 1 } });
  f.settings.paused = true;
  f.advance(3600000); f.work.tick(); assert.equal(f.sent.length, 0);
  assert.throws(() => f.work.runRoutine(f.id, row.id), /paused/);
  f.settings.paused = false; f.work.tick(); assert.equal(f.sent.length, 0);
  f.advance(61000); f.work.tick(); assert.equal(f.sent.length, 1);
});

test('every volume ancestor and metadata path refuses symlinks without reading or writing outside', t => {
  for (const component of ['root', 'base', 'memory', 'outputs', 'work.json', 'routines.json']) {
    const f = fixture(t), outside = mkdtempSync(join(tmpdir(), 'strata-outside-volume-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'MEMORY.md'), 'Outside private memory');
    writeFileSync(join(outside, 'sentinel.txt'), 'Unchanged');
    const root = join(f.directory, 'bot-volumes'), base = join(root, f.id);
    mkdirSync(base, { recursive: true });
    const link = component === 'root' ? root : component === 'base' ? base : component === 'routines.json' ? join(root, component) : join(base, component);
    if (component === 'root' || component === 'base') rmSync(link, { recursive: true });
    if (component.endsWith('.json')) {
      const target = join(outside, 'settings.json'); writeFileSync(target, component === 'routines.json' ? '[]' : '{"rules":[]}'); symlinkSync(target, link);
    } else symlinkSync(outside, link);
    if (component === 'routines.json') {
      assert.throws(() => createBotWork(f.options), /links/);
      assert.throws(() => f.work.putRoutine(f.id, { title: 'Do not schedule', prompt: 'No', schedule: { kind: 'every', minutes: 1 } }), /links/);
    } else {
      assert.throws(() => f.work.list(f.id), /links/);
      if (['root','base','outputs'].includes(component)) assert.throws(() => f.work.putFile(f.id, { path: 'outputs/sentinel.txt', content: 'Do not write' }), /links/);
    }
    assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'Unchanged');
  }
});
