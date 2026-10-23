import { json, error, readBody } from './util.mjs';
import { isLocalCompanionRequest } from './companion-routes.mjs';

/* The paired phone edits a roster through the same normalize()/update()
   validation in bots-team.mjs that the desktop team editor uses. */
export function createCompanionTeamRoutes({ bots, port }) {
  return async (req, res, url) => {
    res.removeHeader('access-control-allow-origin');
    res.setHeader('cache-control', 'no-store');
    if (!isLocalCompanionRequest(req, typeof port === 'function' ? port() : port)) return error(res, 403, 'Open Strata on this Mac to edit team members.');
    try {
      if ([...url.searchParams].length) return error(res, 400, 'Team member actions take no URL settings.');
      const match = /^\/api\/companion\/teams\/(team_[a-f0-9-]+)\/members$/.exec(url.pathname);
      if (!match) return error(res, 404, 'Unknown companion team action.');
      const teamId = match[1];
      if (req.method === 'GET') {
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) return error(res, 400, 'Team member reads take no request body.');
        const team = bots.team.list().teams.find(row => row.id === teamId);
        if (!team) return error(res, 404, 'This team is unavailable.');
        const roster = (await bots.list()).bots.map(bot => ({ id: bot.id, name: bot.name, paused: bot.paused === true }));
        const members = team.memberIds.map(id => {
          const bot = roster.find(row => row.id === id);
          return { id, name: bot?.name ?? 'Unavailable teammate', role: team.briefing?.members?.find(member => member.botId === id)?.role ?? '', paused: bot?.paused === true, available: !!bot && !bot.paused };
        });
        return json(res, 200, { team: { id: team.id, name: team.name, memberIds: [...team.memberIds], coordinatorId: team.coordinatorId, revision: team.revision }, members, roster });
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req, 64 * 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['memberIds', 'coordinatorId', 'expectedRevision'].includes(key))) return error(res, 400, 'Choose supported member settings.');
        if (body.memberIds === undefined && body.coordinatorId === undefined) return error(res, 400, 'Choose members or a coordinator to change.');
        const patch = {};
        for (const key of ['memberIds', 'coordinatorId', 'expectedRevision']) if (body[key] !== undefined) patch[key] = body[key];
        return json(res, 200, bots.team.update(teamId, patch));
      }
      return error(res, 405, 'This companion team action is unavailable.');
    } catch (e) { return error(res, e.status ?? 400, e.message ?? 'The team could not be updated.', e.code ? { code: e.code } : {}); }
  };
}
