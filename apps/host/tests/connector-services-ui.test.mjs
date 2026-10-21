import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile(new URL('../src/lib/connector-services.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const ui = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('service actions follow host defaults without inventing browser login for bearer services', () => {
  const service = { id: 'fixture', url: 'https://fixture.invalid/mcp' };
  assert.equal(ui.connectorServiceAction({ ...service, authTypes: ['oauth', 'bearer'] }), 'oauth');
  assert.equal(ui.connectorServiceAction({ ...service, authTypes: ['bearer', 'oauth'] }), 'key');
  assert.equal(ui.connectorServiceAction({ ...service, authTypes: ['bearer'] }), 'key');
  assert.equal(ui.connectorServiceAction({ ...service, authTypes: ['none', 'bearer', 'oauth'] }), 'account');
  assert.equal(ui.connectorServiceAction({ ...service, url: undefined, authTypes: ['none', 'oauth'] }), 'advanced');
});

test('service identities are local marks and a read-only preset retains its service identity', () => {
  assert.deepEqual(ui.connectorServiceIdentity('linear-readonly'), ui.connectorServiceIdentity('linear'));
  assert.notEqual(ui.connectorServiceIdentity('slack').mark, ui.connectorServiceIdentity('github').mark);
  assert.equal(ui.connectorServiceIdentity('https://host.invalid/icon').mark, 'custom');
  assert.equal(ui.connectorServiceIdentity().mark, 'custom');
  assert.equal(ui.connectorServiceIdentity('botai-google-calendar','Google Calendar').initials,'GC');
  assert.equal(JSON.stringify(['linear', 'slack', 'github', 'notion', 'atlassian'].map(ui.connectorServiceIdentity)).includes('https://'), false);
});

test('directory-only services never become direct login or account creation actions', () => {
  const service={id:'fixture',transport:'http',url:'https://fixture.invalid/mcp',authTypes:['oauth']};
  for(const setupState of ['configuration','managed','unavailable','future-state']) assert.equal(ui.connectorServiceAction({...service,setupState}),'setup');
  assert.equal(ui.connectorServiceAction({...service,setupState:'ready'}),'oauth');
  assert.equal(ui.connectorServiceAction({...service,url:'https://fixture.invalid/${API_KEY}'}),'setup');
  assert.equal(ui.connectorServiceAction({...service,authTypes:[]}),'setup');
});

test('public setup links reject credentials, unsafe protocols and template endpoints', () => {
  assert.equal(ui.connectorServiceLink('https://github.com/example/service/blob/main/README.md#setup'),'https://github.com/example/service/blob/main/README.md#setup');
  for(const value of [undefined,'javascript:alert(1)','http://fixture.invalid/setup','https://owner:secret@fixture.invalid/mcp','https://fixture.invalid/mcp?api_key=secret','https://fixture.invalid/mcp?access_token=secret','https://fixture.invalid/mcp/${TOKEN}','https://fixture.invalid/mcp/%7BTOKEN%7D']) assert.equal(ui.connectorServiceLink(value),null);
});

test('advanced configuration needs a published HTTP endpoint with known authentication', () => {
  const service={id:'fixture',setupState:'configuration',transport:'http',url:'https://fixture.invalid/mcp',authTypes:['oauth']};
  assert.equal(ui.connectorConfigurationURL(service),'https://fixture.invalid/mcp');
  for(const change of [{setupState:'managed'},{setupState:'unavailable'},{setupState:undefined},{url:undefined},{url:'https://fixture.invalid/${WORKSPACE}'},{url:'https://fixture.invalid/mcp#fragment'},{authTypes:[]},{authTypes:['unknown']},{transport:'stdio'}]) assert.equal(ui.connectorConfigurationURL({...service,...change}),null);
});
