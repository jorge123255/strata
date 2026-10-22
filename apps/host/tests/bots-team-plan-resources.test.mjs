import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {teamPlanResourceKey,teamPlanResourcesOverlap} from '../server/bots-team-plan-resources.mjs';
import {createTeamChannels} from '../server/bots-team-channel.mjs';
test('actual local aliases and overlapping folders conflict; independent working copies remain separate',t=>{
 const d=mkdtempSync(join(tmpdir(),'plan-resource-'));t.after(()=>rmSync(d,{recursive:true,force:true}));mkdirSync(join(d,'repo'));mkdirSync(join(d,'other'));symlinkSync(join(d,'repo'),join(d,'alias'));
 const bot=workspace=>({id:'one',execution:{kind:'local'},computerMode:'host',workspace});
 const root=teamPlanResourceKey(bot(join(d,'repo')));assert.equal(root,teamPlanResourceKey({...bot(join(d,'alias')),id:'another'}));assert.equal(teamPlanResourcesOverlap(root,teamPlanResourceKey(bot(join(d,'repo','new-folder')))),true);assert.equal(teamPlanResourcesOverlap(root,teamPlanResourceKey(bot(join(d,'other')))),false);
 const guest={id:'guest',execution:{kind:'local'},computerMode:'cua',workspace:'/workspace',hostFolder:{path:join(d,'alias'),access:'read-write'}};assert.equal(teamPlanResourceKey(guest),root);
 assert.equal(teamPlanResourceKey({...guest,hostFolder:undefined}), 'computer:guest');
 assert.equal(teamPlanResourceKey({execution:{kind:'ssh',host:'alias',user:'root'}}),teamPlanResourceKey({execution:{kind:'ssh',host:'different-alias',user:'user'}}),'unproved remote aliases cannot claim isolated filesystems');
});
test('channel plan reference survives reload and invalid references do not alter history',t=>{
 const directory=mkdtempSync(join(tmpdir(),'plan-channel-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let c=createTeamChannels({directory});const planId='tp_01234567-0123-4123-8123-0123456789ab',input={author:{type:'user',name:'You'},content:'Bounded requested work',workMode:'work',planId};c.append('team_fixture',input);c=createTeamChannels({directory});assert.equal(c.snapshot('team_fixture').messages[0].planId,planId);assert.throws(()=>c.append('team_fixture',{...input,planId:'invalid'}),{status:400});assert.equal(c.snapshot('team_fixture').messages.length,1);
});
