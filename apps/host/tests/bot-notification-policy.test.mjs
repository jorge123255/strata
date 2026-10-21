import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
const {code}=await transform(await readFile(new URL('../src/lib/notification-policy.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'});
const policy=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const event=(sequence=1,type='chat',id='a')=>({id:`event:${sequence}`,sequence,kind:'reply',createdAt:'2026-10-21T12:00:00Z',title:'New reply',body:'Your bot has replied.',destination:{type,id}});
test('notification destinations cannot navigate to arbitrary URLs or execute actions',()=>{
 assert.equal(policy.notificationHref({type:'team',id:'team-1'}),'#/bots/teams?team=team-1');
 assert.equal(policy.notificationHref({type:'chat',id:'chat_1'}),'#/chat/chat_1');
 for(const value of [{type:'chat',id:'https://example.test'},{type:'approval',id:'x'},{type:'chat',id:'x',command:'approve'},{type:'chat',id:"');alert(1)"},null])assert.equal(policy.notificationHref(value),null);
 assert.equal(policy.isNotificationSettingsDestination({type:'notifications',id:'settings'}),true);
 assert.equal(policy.isNotificationSettingsDestination({type:'notifications',id:'elsewhere'}),false);
 assert.equal(policy.isNotificationSettingsDestination({type:'notifications',id:'settings',command:'approve'}),false);
 assert.equal(policy.notificationDestination({type:'notifications',id:'settings'}),null);
 assert.equal(policy.isBotCompanionActivityDestination({type:'bots',id:'activity'}),true);
 for(const destination of [{type:'bots',id:'activity',approve:true},{type:'bots',id:'settings'},{type:'approval',id:'activity'},null])assert.equal(policy.isBotCompanionActivityDestination(destination),false);
 assert.equal(policy.notificationDestination({type:'bots',id:'activity'}),null);
 assert.equal(policy.validNotification({...event(),destination:{type:'bots',id:'activity'}}),false,'Internal companion navigation does not expand notification authority.');
});
test('opt in, exact room, mute and each category are independent',()=>{
 const prefs={...policy.DEFAULT_NOTIFICATION_PREFERENCES,enabled:true};
 assert.equal(policy.shouldNotify(event(),policy.DEFAULT_NOTIFICATION_PREFERENCES,null),false);
 assert.equal(policy.shouldNotify(event(),prefs,{type:'chat',id:'a'}),false);
 assert.equal(policy.shouldNotify(event(),prefs,{type:'chat',id:'b'}),true);
 assert.equal(policy.shouldNotify(event(),{...prefs,muted:['chat:a']},null),false);
 assert.equal(policy.shouldNotify(event(),{...prefs,muted:['team:a']},null),true);
 for(const [kind,key]of[['reply','replies'],['team_message','teams'],['approval','approvals'],['completed','work'],['failed','work']])assert.equal(policy.shouldNotify({...event(),kind},{...prefs,[key]:false},null),false);
});
test('inbox deduplicates canonical IDs, bounds storage and rejects malformed entries',()=>{
 assert.equal(policy.mergeNotificationInbox([event()], [event(),event(2)]).length,2);
 const rows=policy.mergeNotificationInbox([],Array.from({length:120},(_,i)=>event(i+1)));
 assert.equal(rows.length,100);assert.equal(rows[0].sequence,120);assert.equal(rows.at(-1).sequence,21);
 assert.deepEqual(policy.mergeNotificationInbox([], [{...event(),sequence:-1},{...event(),destination:{type:'tool',id:'x'}},{...event(),body:'x'.repeat(2001)}]),[]);
});
