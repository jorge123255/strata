/** Bot-written command drafts become callable only through explicit reviewed grants. */
import { randomUUID } from 'node:crypto';
import { botExtensionFault as fault, extensionHash as hash, extensionIds, extensionKeys, extensionText, privateExtensionStore } from './bots-extension-store.mjs';
import { createdToolSchema, createdToolInput, createdToolRequirements } from './bots-runtime/created-tools.mjs';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const inputSchema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = () => ({ type: 'string' });
const legacyContentFields = ['name', 'description', 'command', 'inputSchema', 'timeoutSeconds'];
const contentFields = [...legacyContentFields, 'requirements'];
const definitions = [
  { name: 'draft_tool', description: 'Save a reusable command tool draft. Optional requirements declare supported platforms, required executable basenames and relative workspace files, never installation commands. Check readiness with check_created_tool; test with test_created_tool. The owner must review and enable sharing. STRATA_TOOL_INPUT supplies JSON as data. This never runs the command.', inputSchema: inputSchema({ name: string(), description: string(), command: string(), inputSchema: { type: 'object' }, timeoutSeconds: { type: 'integer' }, requirements: { type: 'object', properties: { platforms: { type: 'array', items: { type: 'string', enum: ['darwin', 'linux', 'win32'] }, maxItems: 3 }, executables: { type: 'array', items: { type: 'string' }, maxItems: 16 }, workspaceFiles: { type: 'array', items: { type: 'string' }, maxItems: 16 } }, additionalProperties: false } }, ['name', 'command']) },
  { name: 'list_created_tools', description: 'Discover a compact page of your own tool drafts and frozen assigned command tools. Follow nextAfterToolId for later pages; use read_created_tool for one exact command and input schema.', inputSchema: inputSchema({ afterToolId: string() }) },
  { name: 'read_created_tool', description: 'Read one of your current command-tool drafts or a frozen assigned command tool.', inputSchema: inputSchema({ toolId: string() }, ['toolId']) },
  { name: 'authorize_created_tool', description: 'Validate exact reusable-tool authority. This does not execute a command or grant new access; the selected computer checks it again after approval. Check mode inspects only declared requirements and does not accept tool input.', inputSchema: inputSchema({ mode: { type: 'string', enum: ['run', 'test', 'check'] }, toolId: string(), expectedDigest: string(), input: { type: 'object' } }, ['mode', 'toolId', 'expectedDigest']) },
];
export function createBotCreatedTools({ directory, hasBot = () => false, hasTeam = () => false, teamAccess = () => false, notify = () => {}, now = () => new Date().toISOString() }) {
  const store = privateExtensionStore(directory, 'bots-created-tools.json', { version: 1, tools: [] }), state = store.value;
  if (!Array.isArray(state.tools)) throw fault(503, 'Saved reusable tools are invalid. They were left unchanged.');
  const changed = () => { store.save(state); notify('bots', { createdTools: true }); };
  // The legacy proof must stay byte-identical until requirements are explicitly added.
  const proof = tool => hash([tool.id, tool.revision, ...legacyContentFields.map(key => tool[key]), tool.status, tool.botIds, tool.teamIds, ...(tool.requirements ? [{ requirements: tool.requirements }] : [])]);
  const publicTool = tool => { const { provenance, ...safe } = structuredClone(tool); return { ...safe, digest: proof(tool), ...(provenance ? { provenance: { botId: provenance.botId } } : {}) }; };
  const requireTool = id => { const tool = state.tools.find(tool => tool.id === id); if (!tool) throw fault(404, 'This reusable tool is no longer available.'); return tool; };
  function content(input, old = {}) {
    let schema;
    try { schema = createdToolSchema(input.inputSchema ?? old.inputSchema); } catch (error) { throw fault(400, error.message); }
    const timeoutSeconds = input.timeoutSeconds ?? old.timeoutSeconds ?? 30;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) throw fault(400, 'Choose a command timeout between 1 and 120 seconds.');
    let requirements;
    try { requirements = createdToolRequirements(Object.hasOwn(input, 'requirements') ? input.requirements : old.requirements); } catch (error) { throw fault(400, error.message); }
    return { name: extensionText(input.name ?? old.name, 120, 'tool name', true), description: extensionText(input.description ?? old.description ?? '', 2000, 'tool description'), command: extensionText(input.command ?? old.command, 32000, 'tool command', true), inputSchema: schema, timeoutSeconds, ...(requirements ? { requirements } : {}) };
  }
  function create(input, provenance) {
    extensionKeys(input, contentFields);
    if (state.tools.length >= 256) throw fault(409, 'Remove unused tool drafts before adding more.');
    const tool = { id: `tool_${randomUUID()}`, ...content(input), status: 'draft', revision: 1, botIds: [], teamIds: [], createdAt: now(), updatedAt: now(), ...(provenance ? { provenance } : {}) };
    state.tools.push(tool); changed(); return { tool: publicTool(tool) };
  }
  function update(id, input) {
    extensionKeys(input, [...contentFields, 'status', 'botIds', 'teamIds', 'expectedRevision', 'expectedDigest']);
    const current = requireTool(id);
    if (input.expectedRevision !== current.revision || input.expectedDigest !== proof(current)) throw fault(409, 'This tool changed on another device. Refresh and review its current definition before saving.');
    if (input.status !== undefined && !['draft', 'enabled'].includes(input.status)) throw fault(400, 'Choose Draft or Enabled.');
    const botIds = extensionIds(input.botIds ?? current.botIds, 'bots'), teamIds = extensionIds(input.teamIds ?? current.teamIds, 'teams', 50);
    if (botIds.some(id => !current.botIds.includes(id) && !hasBot(id)) || teamIds.some(id => !current.teamIds.includes(id) && !hasTeam(id))) throw fault(404, 'Choose bots and teams that still exist.');
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw fault(409, 'This tool’s revision cannot be advanced. Create a new draft from its reviewed definition.');
    const edited = content(input, current), contentChanged = contentFields.some(key => JSON.stringify(edited[key]) !== JSON.stringify(current[key]));
    const next = { ...current, ...edited, status: contentChanged ? 'draft' : input.status ?? current.status, botIds, teamIds, revision: current.revision + 1, updatedAt: now() };
    if (!edited.requirements) delete next.requirements;
    state.tools[state.tools.indexOf(current)] = next; changed(); return { tool: publicTool(next) };
  }
  function grant(tool, bot, recovery = false) {
    const bound = bot.teamContext;
    return tool.botIds.includes(bot.id) || !!(bound?.teamId && tool.teamIds.includes(bound.teamId) && (recovery ? hasTeam(bound.teamId) : teamAccess(bound.teamId, bot.id, bound.teamRunId)));
  }
  function snapshot(bot, recovery = false) {
    const assignments = state.tools.filter(tool => tool.status === 'enabled' && grant(tool, bot, recovery)).map(tool => ({ id: tool.id, digest: proof(tool), name: tool.name, botGranted: tool.botIds.includes(bot.id), ...(bot.teamContext?.teamId && tool.teamIds.includes(bot.teamContext.teamId) ? { teamId: bot.teamContext.teamId, teamRunId: bot.teamContext.teamRunId } : {}) }));
    return { revision: hash(assignments), assignments, instructions: 'Reusable command tools are available through list_created_tools, read_created_tool and run_created_tool. Commands execute on this conversation’s selected computer and workspace with its normal approvals. If a tool is missing, write and test a script with your existing file/command tools, then use draft_tool to save a reusable version. You may test your own exact draft with test_created_tool. Drafting, testing and reporting success do not enable or share a tool; the owner reviews its exact definition and grants access. STRATA_TOOL_INPUT contains the complete JSON input object; treat it as data, never interpolate it into shell source.' };
  }
  function allowed(context) {
    return (context.bot.extensionSnapshots?.createdTools?.assignments || []).flatMap(frozen => {
      const current = state.tools.find(tool => tool.id === frozen.id);
      if (!current || current.status !== 'enabled' || proof(current) !== frozen.digest) return [];
      const direct = frozen.botGranted && current.botIds.includes(context.bot.id), bound = context.bot.teamContext;
      const shared = frozen.teamId && bound?.teamId === frozen.teamId && bound?.teamRunId === frozen.teamRunId && current.teamIds.includes(frozen.teamId) && teamAccess(frozen.teamId, context.bot.id, frozen.teamRunId);
      return direct || shared ? [publicTool(current)] : [];
    });
  }
  const ownDrafts = context => state.tools.filter(tool => tool.status === 'draft' && tool.provenance?.botId === context.bot.id).map(publicTool);
  const visible = context => [...allowed(context), ...ownDrafts(context)];
  function authorize(args, context) {
    context.assertLive();
    extensionKeys(args, ['mode', 'toolId', 'expectedDigest', 'input']);
    if (context.bot.policy === 'plan' || context.bot.teamConversationOnly || !['run', 'test', 'check'].includes(args.mode)) throw fault(403, 'Command tools cannot execute in this permission or team conversation mode.');
    const selected = (args.mode === 'check' ? visible(context) : args.mode === 'test' ? ownDrafts(context) : allowed(context)).find(tool => tool.id === args.toolId && tool.digest === args.expectedDigest);
    if (!selected) throw fault(403, 'This exact command tool was not assigned, its draft changed, or access was removed.');
    if (args.mode === 'check') { if (args.input !== undefined) throw fault(400, 'A readiness check does not accept command input.'); }
    else try { createdToolInput(selected.inputSchema, args.input); } catch (error) { throw fault(400, error.message); }
    return { tool: structuredClone(selected) };
  }
  const list = () => ({ tools: state.tools.map(publicTool), createdToolsSupported: true, createdToolReadinessSupported: true });
  try {
    if (state.tools.length > 256 || new Set(state.tools.map(tool => tool?.id)).size !== state.tools.length) throw new Error();
    for (const tool of state.tools) {
      extensionKeys(tool, ['id', ...contentFields, 'status', 'revision', 'botIds', 'teamIds', 'createdAt', 'updatedAt', 'provenance']);
      if (!/^tool_[a-f0-9-]{36}$/.test(tool.id) || !['draft', 'enabled'].includes(tool.status) || !Number.isSafeInteger(tool.revision) || tool.revision < 1 || !Number.isFinite(Date.parse(tool.createdAt)) || !Number.isFinite(Date.parse(tool.updatedAt))) throw new Error();
      content(tool); extensionIds(tool.botIds, 'bots'); extensionIds(tool.teamIds, 'teams', 50);
      if (tool.provenance) { extensionKeys(tool.provenance, ['botId', 'chatId', 'turnId']); for (const value of Object.values(tool.provenance)) if (typeof value !== 'string' || !value || value.length > 200 || value.includes('\0')) throw new Error(); }
    }
  } catch { throw fault(503, 'Saved reusable tools are invalid. They were left unchanged.'); }
  return { create, update, snapshot, recoverySnapshot: bot => snapshot(bot, true), authorize, list,
    owns: name => definitions.some(tool => tool.name === name), tools: bot => structuredClone(definitions.filter(tool => bot.policy !== 'plan' || ['list_created_tools', 'read_created_tool'].includes(tool.name))),
    async execute(name, args, context) {
      context.assertLive();
      if (name === 'draft_tool') {
        if (context.bot.policy === 'plan' || context.bot.teamConversationOnly) throw fault(403, 'Tool drafting is unavailable in Plan or team conversation mode.');
        if (!await context.requestPermission({ id: context.toolCallId || `draft_${randomUUID()}`, name, args, reason: 'Save this command tool as a draft for review? This does not run or enable it.' })) throw fault(403, 'Tool draft permission was not granted.');
        context.assertLive(); return result(create(args, { botId: context.bot.id, chatId: context.chatId, turnId: context.turnId }));
      }
      if (name === 'authorize_created_tool') return result(authorize(args, context));
      if (name === 'list_created_tools') {
        extensionKeys(args, ['afterToolId']);
        if (args.afterToolId !== undefined && (typeof args.afterToolId !== 'string' || !/^tool_[a-f0-9-]{36}$/.test(args.afterToolId))) throw fault(400, 'Choose the exact next tool cursor from the previous page.');
        const tools = visible(context).sort((a, b) => a.id.localeCompare(b.id)), after = args.afterToolId === undefined ? -1 : tools.findIndex(tool => tool.id === args.afterToolId);
        if (args.afterToolId !== undefined && after < 0) throw fault(409, 'This tool list changed. Start discovery again from the first page.');
        const page = tools.slice(after + 1, after + 26);
        return result({ tools: page.map(({ id, name, description, status, revision, digest }) => ({ id, name, description: description.slice(0, 500), status, revision, digest })), nextAfterToolId: after + 1 + page.length < tools.length ? page.at(-1).id : null });
      }
      if (name === 'read_created_tool') { extensionKeys(args, ['toolId']); const tool = visible(context).find(tool => tool.id === args.toolId); if (!tool) throw fault(404, 'This reusable tool was not assigned to this conversation.'); return result({ tool }); }
      throw fault(404, 'Unknown reusable tool action.');
    },
    handle(method, url, body) {
      if ([...url.searchParams].length) throw fault(400, 'This reusable tool action does not accept query fields.');
      if (url.pathname === '/api/bots/tools') { if (method === 'GET') return list(); if (method === 'POST') return create(body); }
      const match = /^\/api\/bots\/tools\/(tool_[a-f0-9-]+)$/.exec(url.pathname);
      if (match && method === 'PATCH') return update(match[1], body);
      if (match && method === 'DELETE') { extensionKeys(body, ['expectedRevision', 'expectedDigest']); const tool = requireTool(match[1]); if (body.expectedRevision !== tool.revision || body.expectedDigest !== proof(tool)) throw fault(409, 'This tool changed on another device. Refresh and review its current definition before deleting.'); state.tools.splice(state.tools.indexOf(tool), 1); changed(); return { removed: true }; }
      throw fault(404, 'Unknown reusable tool action.');
    }, close() {} };
}
