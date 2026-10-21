/** Public team roles are separate from each bot's private profile and permissions. */

const fault = message => Object.assign(new Error(message), { status: 400 });
export const TEAM_BRIEFING_LIMITS = Object.freeze({ instructions: 8000, role: 120, memberInstructions: 4000, total: 24000 });
const ownObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalidControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function keys(value, allowed) {
  if (!ownObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fault('Choose supported public team instructions.');
}
function text(value, maximum, label) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum || invalidControl.test(value)) throw fault(`Enter a valid ${label} within ${maximum} characters.`);
  return value.replace(/\r\n?/g, '\n').trim();
}
function roster(memberIds) {
  if (!Array.isArray(memberIds) || memberIds.length < 2 || new Set(memberIds).size !== memberIds.length || memberIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(id))) throw fault('Choose the current team members before setting their instructions.');
  return new Set(memberIds);
}

/** Canonical full replacement. Missing fields clear them; an absent briefing is empty. */
export function normalizeTeamBriefing(input, memberIds) {
  const allowed = roster(memberIds);
  if (input === undefined) return { instructions: '', members: [] };
  keys(input, ['instructions', 'members']);
  const instructions = text(input.instructions, TEAM_BRIEFING_LIMITS.instructions, 'team instruction');
  const rows = input.members === undefined ? [] : input.members;
  if (!Array.isArray(rows)) throw fault('Give each current team member one set of public instructions.');
  const seen = new Set(), members = [];
  let total = instructions.length;
  for (const row of rows) {
    keys(row, ['botId', 'role', 'instructions']);
    if (typeof row.botId !== 'string' || !allowed.has(row.botId) || seen.has(row.botId)) throw fault('Give each current team member one set of public instructions.');
    seen.add(row.botId);
    const role = text(row.role, TEAM_BRIEFING_LIMITS.role, 'team role');
    const instructions = text(row.instructions, TEAM_BRIEFING_LIMITS.memberInstructions, 'member instruction');
    total += role.length + instructions.length;
    if (total > TEAM_BRIEFING_LIMITS.total) throw fault('Keep the public team instructions within 24,000 characters in total.');
    if (role || instructions) members.push({ botId: row.botId, role, instructions });
  }
  members.sort((a, b) => a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0);
  return { instructions, members };
}

/** Called once when a host turn starts; no private bot instructions are read. */
export function teamBriefingContext(team, botId) {
  if (team?.briefing === undefined) return '';
  const briefing = normalizeTeamBriefing(team.briefing, team.memberIds);
  if (!briefing.instructions && !briefing.members.length) return '';
  if (botId !== undefined && !team.memberIds.includes(botId)) throw fault('Choose a current member for this public team context.');
  return `Public team briefing (shared with this team; it does not change models, computers, tools or approval policies):\n${JSON.stringify(briefing)}${botId === undefined ? '' : `\nYour team member ID is ${JSON.stringify(botId)}. Use only the role and instructions explicitly assigned to that ID; do not infer responsibilities from names.`}`;
}
