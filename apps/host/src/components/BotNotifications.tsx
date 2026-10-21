import { Btn, Dialog, ErrorNotice, Field } from './ui';
import { destinationKey, type NotificationDestination, type NotificationPreferences } from '../lib/notification-policy';
import { enableNotifications, openNotificationDestination, openNotifications, refreshNotifications, saveNotificationPreferences, sendTestNotification, toggleConversationMute, useNotifications } from '../lib/notifications';
import { relTime } from '../lib/format';
import './BotNotifications.css';

export function NotificationMuteButton({ destination, menu = false }: { destination: NotificationDestination; menu?: boolean }) {
  const state = useNotifications(), muted = state.settings.muted.includes(destinationKey(destination));
  if (menu) return <button className="menu__item" role="menuitem" disabled={!state.ready || !state.supported || state.busy} onClick={() => { void toggleConversationMute(destination); }}>{muted ? 'Unmute notifications' : 'Mute notifications'}</button>;
  return <Btn size="sm" variant="ghost" disabled={!state.ready || !state.supported || state.busy} aria-pressed={muted} onClick={() => { void toggleConversationMute(destination); }}>{muted ? 'Unmute notifications' : 'Mute notifications'}</Btn>;
}
export function BotNotificationSettings({ showInbox = true }: { showInbox?: boolean }) {
  const state = useNotifications();
  const toggle = (key: keyof Omit<NotificationPreferences, 'muted'>, label: string, hint: string) => <Field label={label} hint={hint}><button className="st-toggle" role="switch" aria-label={label} aria-checked={state.settings[key]} disabled={!state.ready || !state.supported || state.busy || key !== 'enabled' && !state.settings.enabled} onClick={() => { if (key === 'enabled' && !state.settings.enabled) void enableNotifications(); else void saveNotificationPreferences({ [key]: !state.settings[key] }); }}/></Field>;
  return <section className="bot-notification-settings"><h2 className="h3">Notifications</h2><p className="small muted">Stay in the conversation while your bots work. Mac notifications arrive while Strata is running. The conversation you are reading stays quiet.</p><div className="st-card st-card--flush">
    {toggle('enabled', 'Mac notifications', 'Allow Strata in macOS Notification Center.')}
    {toggle('replies', 'Bot replies', 'A bot has finished its reply.')}
    {toggle('teams', 'Team messages', 'Teammates speak in a shared channel.')}
    {toggle('work', 'Completed work', 'Team work or a routine finishes or needs attention.')}
    {toggle('approvals', 'Approval requests', 'Open Strata to review the action before it runs.')}
    {toggle('sound', 'Sound', 'Play the system notification sound.')}
  </div><p className="xs muted" role="status">{state.desktop.detail ?? (state.ready ? 'Native banners need the updated Strata Mac app.' : 'Checking notification settings…')}{state.desktop.authorization === 'denied' ? ' Open System Settings → Notifications → Strata to allow notifications.' : ''}</p><div className="row">{showInbox ? <Btn size="sm" onClick={() => openNotifications()}>Recent notifications</Btn> : null}<Btn size="sm" disabled={state.busy} onClick={() => { void refreshNotifications(); }}>Refresh settings</Btn><Btn size="sm" disabled={state.busy || !state.settings.enabled || !state.desktop.available || state.desktop.authorization !== 'authorized'} onClick={() => { void sendTestNotification(); }}>Send test notification</Btn></div>{state.testStatus ? <p className="xs muted" role="status">{state.testStatus}</p> : null}{state.error ? <ErrorNotice message={state.error} action="Retry" onRetry={() => { void refreshNotifications(); }}/> : null}</section>;
}
export function BotNotificationCenter() {
  const state = useNotifications();
  return <Dialog open={state.open} title="Notifications" className="bot-notification-dialog" onClose={() => openNotifications(false)} actions={<Btn onClick={() => openNotifications(false)}>Done</Btn>}><div className="bot-notification-inbox">{state.inbox.length ? state.inbox.map(event => <button key={event.id} onClick={() => openNotificationDestination(event.destination)}><span className="bot-notification-inbox-dot" data-attention={event.kind === 'approval' || event.kind === 'failed' || undefined}/><span><strong>{event.title}</strong><small>{event.body}</small></span><time dateTime={event.createdAt}>{relTime(event.createdAt)}</time></button>) : <div className="bot-notification-empty"><h3>You are all caught up</h3><p>New bot replies, team messages and work updates will appear here.</p></div>}</div><BotNotificationSettings showInbox={false}/></Dialog>;
}
