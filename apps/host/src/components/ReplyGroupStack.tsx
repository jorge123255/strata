import { useState } from 'react';
import type { Entrance } from '../lib/chat-motion';
import type { Bot, BotTeamChannelMessage } from '../lib/bots';
import { REPLY_GROUP_PREVIEW, replyGroupLabel, replyGroupPreview, replyGroupStaggerMs } from '../lib/reply-group';
import { cx } from '../lib/format';
import { CuaBotAvatar } from './CuaBotAvatar';

/** Compact stack for one @everyone burst. Past five replies, the header opens the rest. */
export function ReplyGroupStack({ messages, triggerId, bots, entranceFor, disabled, onReply }: {
  messages: BotTeamChannelMessage[];
  triggerId: string;
  bots: Bot[];
  entranceFor: (id: string) => Entrance | undefined;
  disabled: boolean;
  onReply: (message: BotTeamChannelMessage) => void;
}) {
  const [open, setOpen] = useState(false);
  if (messages.length < 2) return null;
  const label = replyGroupLabel(messages.length);
  const canToggle = messages.length > REPLY_GROUP_PREVIEW;
  const shown = open || !canToggle ? messages : messages.slice(0, REPLY_GROUP_PREVIEW);
  return <section className="bot-room-reply-group" data-reply-group={triggerId} aria-label={label}>
    {canToggle
      ? <button type="button" className="bot-room-reply-group-header" aria-expanded={open} onClick={() => setOpen(value => !value)}>{label}</button>
      : <p className="bot-room-reply-group-header">{label}</p>}
    {shown.map((message, index) => {
      const name = message.author.name;
      const bot = bots.find(item => item.id === message.author.botId);
      const entrance = entranceFor(message.id);
      return <article key={message.id} className={cx('bot-room-reply-row', entrance ? 'msg-enter' : false)} style={entrance ? { animationDuration: `${entrance.ms}ms`, animationDelay: `${replyGroupStaggerMs(index)}ms` } : undefined} data-message-id={message.id} aria-label={name}>
        <div className="bot-room-message-face"><CuaBotAvatar name={name} config={message.author.avatarConfig ?? bot?.avatarConfig} size={28}/></div>
        <div className="bot-room-reply-row-copy"><strong>{name}</strong><p>{replyGroupPreview(message.content)}</p></div>
        <button type="button" disabled={disabled} onClick={() => onReply(message)}>Reply<span className="sr-only"> to {name}</span></button>
      </article>;
    })}
  </section>;
}
