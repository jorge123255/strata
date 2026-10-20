/** Bot-authored skills remain reviewable drafts; library preferences stay separate. */
import { randomUUID } from 'node:crypto';
import { skillEdit } from './skill-edits.mjs';
import { botExtensionFault as fault, extensionHash as hash, extensionIds, extensionKeys, privateExtensionStore } from './bots-extension-store.mjs';

const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const definitions = [
  { name: 'draft_skill', description: 'Propose reusable instructions as a skill draft for the owner to review. This does not enable it or grant tools.', inputSchema: schema({ name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, triggers: { type: 'array', items: { type: 'string' } } }, ['name', 'body']) },
  { name: 'list_skills', description: 'List only the skills assigned to this conversation.', inputSchema: schema({}) },
  { name: 'read_skill', description: 'Read a skill from this conversation’s frozen assigned versions.', inputSchema: schema({ id: { type: 'string' } }, ['id']) },
];
export function createBotSkills({ directory, library = () => [], workspacePath = () => null, hasBot = () => false, notify = () => {}, now = () => new Date().toISOString() }) {
  const store = privateExtensionStore(directory, 'bots-skills.json', { version: 1, drafts: [], assignments: {} }), state = store.value;
  if (!Array.isArray(state.drafts) || !state.assignments || Array.isArray(state.assignments)) throw fault(503, 'Saved bot skills are invalid. They were left unchanged.');
  const changed = () => { store.save(state); notify('bots', { skills: true }); };
  const validatedEdit = input => { try { return skillEdit(input); } catch (e) { throw fault(400, e.message); } };
  function catalog() {
    const shared = library().filter(s => typeof s.id === 'string' && typeof s.body === 'string' && s.body.trim()).map(s => ({ id: `library.${s.id}`, name: s.name, description: s.description || '', body: s.body, triggers: s.triggers || [], source: 'library', status: 'enabled', mainChatEnabled: s.enabled !== false, revision: hash([s.name, s.description, s.body, s.triggers]), onlyIn: s.onlyIn || null }));
    return [...shared, ...state.drafts].map(s => ({ ...structuredClone(s), digest: hash([s.name, s.description, s.body, s.triggers]), botIds: Object.entries(state.assignments).filter(([, ids]) => ids.includes(s.id)).map(([id]) => id) }));
  }
  function requireSkill(id) { const item = catalog().find(s => s.id === id); if (!item) throw fault(404, 'This skill is no longer available.'); return item; }
  function create(input, provenance) {
    extensionKeys(input, ['name', 'description', 'body', 'triggers']);
    if (state.drafts.length >= 256) throw fault(409, 'Review or remove older skill drafts before adding more.');
    const edit = validatedEdit(input);
    if (!edit.name || !edit.body) throw fault(400, 'Give the skill a name and instructions.');
    const skill = { id: `skill_${randomUUID()}`, description: '', triggers: [], ...edit, source: 'draft', status: 'draft', revision: 1, createdAt: now(), updatedAt: now(), ...(provenance ? { provenance } : {}) };
    state.drafts.push(skill); changed(); return { skill: requireSkill(skill.id) };
  }
  function update(id, input) {
    extensionKeys(input, ['name', 'description', 'body', 'triggers', 'status', 'expectedRevision', 'expectedDigest']);
    const index = state.drafts.findIndex(s => s.id === id); if (index < 0) throw fault(409, 'Edit shared skills in the main Skills library.');
    if (input.status !== undefined && !['draft', 'enabled'].includes(input.status)) throw fault(400, 'Choose Draft or Enabled.');
    if (input.status === 'enabled' || input.expectedRevision !== undefined || input.expectedDigest !== undefined) {
      const current = requireSkill(id);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision || typeof input.expectedDigest !== 'string' || input.expectedDigest !== current.digest) throw fault(409, 'This skill changed on another device. Refresh and review its current instructions before saving or enabling it.');
    }
    const edited = validatedEdit(input), contentChanged = Object.keys(edited).length > 0;
    // Editing published instructions requires a fresh review; existing chats retain their copy.
    state.drafts[index] = { ...state.drafts[index], ...edited, revision: state.drafts[index].revision + 1, updatedAt: now(), status: contentChanged ? 'draft' : input.status ?? state.drafts[index].status };
    changed(); return { skill: requireSkill(id) };
  }
  function assign(input) {
    extensionKeys(input, ['botId', 'skillIds']);
    if (!hasBot(input.botId)) throw fault(404, 'Choose an existing bot.');
    const ids = extensionIds(input.skillIds, 'skills', 32), selected = ids.map(requireSkill);
    const retained = new Set(state.assignments[input.botId] || []);
    if (selected.some(s => s.status !== 'enabled' && !retained.has(s.id))) throw fault(409, 'Review and enable the skill draft before assigning it.');
    if (selected.filter(s => s.status === 'enabled').reduce((n, s) => n + s.body.length, 0) > 128000 && ids.some(id => !retained.has(id))) throw fault(400, 'Choose fewer skill instructions for this bot.');
    state.assignments[input.botId] = ids; changed(); return list();
  }
  function list(botId) { return { skills: catalog(), assignments: Object.entries(state.assignments).filter(([id]) => !botId || id === botId).map(([botId, skillIds]) => ({ botId, skillIds: [...skillIds] })) }; }
  function snapshot(bot) {
    const ids = state.assignments[bot.id] || [];
    const selected = catalog().filter(s => ids.includes(s.id) && s.status === 'enabled' && (!s.onlyIn || workspacePath(s.onlyIn) === bot.workspace)).map(({ id, name, description, body, revision, digest }) => ({ id, name, description, body, revision, digest }));
    if (selected.reduce((n, s) => n + s.body.length, 0) > 128000) throw fault(409, 'The assigned skill revisions are too long for a new conversation. Remove some skill assignments, then try again.');
    return { revision: hash(selected), assignments: selected, instructions: selected.length ? `The owner assigned these reusable instructions to this conversation. They do not grant additional tool permissions.\n${selected.map(s => `\n<assigned-skill name=${JSON.stringify(s.name)}>\n${s.body}\n</assigned-skill>`).join('\n')}` : '' };
  }
  return { list, create, update, assign, snapshot, owns: name => definitions.some(t => t.name === name), tools: () => structuredClone(definitions),
    async execute(name, args, context) {
      context.assertLive();
      const assigned = context.bot.extensionSnapshots?.skills?.assignments || [];
      if (name === 'draft_skill') {
        if (context.bot.policy === 'plan') throw fault(409, 'Skill creation is unavailable in Plan mode.');
        if (!await context.requestPermission({ id: context.toolCallId || `skill_${randomUUID()}`, name, args, reason: 'Save a skill draft for review?' })) throw fault(403, 'Skill draft permission was not granted.');
        context.assertLive(); return result(create(args, { botId: context.bot.id, chatId: context.chatId, turnId: context.turnId }));
      }
      if (name === 'list_skills') { extensionKeys(args, []); return result({ skills: assigned.map(({ body, ...s }) => s) }); }
      if (name === 'read_skill') { extensionKeys(args, ['id']); const skill = assigned.find(s => s.id === args.id); if (!skill) throw fault(404, 'This skill was not assigned to this conversation.'); return result(skill); }
      throw fault(404, 'Unknown skill tool.');
    },
    handle(method, url, body) {
      if (url.pathname === '/api/bots/skills') { if (method === 'GET') return list(url.searchParams.get('botId')); if (method === 'POST') return create(body); }
      if (url.pathname === '/api/bots/skills/assign' && method === 'POST') return assign(body);
      const match = /^\/api\/bots\/skills\/(skill_[a-f0-9-]+)$/.exec(url.pathname);
      if (match && method === 'PATCH') return update(match[1], body);
      if (match && method === 'DELETE') { const index = state.drafts.findIndex(s => s.id === match[1]); if (index < 0) throw fault(404, 'This draft no longer exists.'); state.drafts.splice(index, 1); for (const id of Object.keys(state.assignments)) state.assignments[id] = state.assignments[id].filter(s => s !== match[1]); changed(); return { removed: true }; }
      throw fault(404, 'Unknown bot skill action.');
    }, close() {} };
}
