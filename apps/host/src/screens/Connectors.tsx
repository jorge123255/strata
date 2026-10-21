import type { BotsSnapshot, BotTeamsSnapshot } from '../lib/bots';
import { navigate, useLocation } from '../lib/router';
import { Screen } from '../components/layout';
import { ErrorNotice } from '../components/ui';
import { BotConnectionsPanel } from './BotConnectors';
import { useBotsResource } from './BotsWorkspace';
import './Bots.css';

/** Accounts have their own destination; bot and team deep links keep their context. */
export function ConnectorsScreen() {
  const location = useLocation();
  const bots = useBotsResource<BotsSnapshot>('/api/bots', 10000);
  const teams = useBotsResource<BotTeamsSnapshot>('/api/bots/teams', 10000);
  const scope = location.query.get('bot') ? 'bot:' + location.query.get('bot') : location.query.get('team') ? 'team:' + location.query.get('team') : 'all';
  return <Screen title="Connectors" sub="Your apps, working with your bots" bare>
    {bots.error || teams.error ? <ErrorNotice message="Some bot or team access choices could not be refreshed." next="Existing grants are retained. Refresh the available choices before changing access." action="Refresh choices" onRetry={() => { void bots.refresh(); void teams.refresh(); }}/> : null}
    <BotConnectionsPanel standalone bots={bots.data?.bots ?? []} teams={teams.data?.teams ?? []} initialScope={scope} initialConnectionId={location.param ?? undefined} onSelect={(id,clearScope) => navigate('connectors', id, clearScope ? undefined : scope.startsWith('bot:') ? {bot:scope.slice(4)} : scope.startsWith('team:') ? {team:scope.slice(5)} : undefined)}/>
  </Screen>;
}
