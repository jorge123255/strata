import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const {code} = await transform(await readFile(new URL('../src/lib/bots.ts', import.meta.url), 'utf8'), {loader:'ts',format:'esm'});
const {mergeBotTeamChannelMessages} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const message = (id,sequence,teamId='crew',content=id) => ({id,sequence,teamId,kind:'message',author:{type:'bot',botId:'a',name:'One'},content,createdAt:'2026-10-21T00:00:00Z'});
test('room pages retain stable identity and chronological order across polling, overlap, and earlier history', () => {
 const previous=[message('m3',3),message('m4',4)];
 const result=mergeBotTeamChannelMessages(previous,[message('m2',2),message('m3',3,'crew','Same durable message'),message('foreign',7,'other'),message('bad',NaN),message('zero',0)],'crew');
 assert.deepEqual(result.map(row=>row.id),['m2','m3','m4']); assert.equal(result[1].content,'Same durable message');
 assert.deepEqual(previous.map(row=>row.content),['m3','m4'],'Merging never mutates the mounted snapshot.');
 assert.deepEqual(mergeBotTeamChannelMessages(result,[message('m5',5),message('m5',5)],'crew').map(row=>row.id),['m2','m3','m4','m5']);
 assert.deepEqual(mergeBotTeamChannelMessages(result,[message('new',1,'another')],'another').map(row=>row.id),['new']);
});

test('a durable message cannot change sequence or replace another sequence after pagination', () => {
 const previous=[message('known',12)];
 assert.throws(()=>mergeBotTeamChannelMessages(previous,[message('known',13)],'crew'),/changed a saved message sequence/);
 assert.throws(()=>mergeBotTeamChannelMessages(previous,[message('replacement',12)],'crew'),/changed a saved message sequence/);
 assert.deepEqual(previous,[message('known',12)]);
});
