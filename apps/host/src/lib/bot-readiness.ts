import type { Bot } from './bots';

export interface BotComputerReadiness { available: boolean; running?: boolean; cleanupConfirmed?: boolean; detail?: string }
export interface BotReadinessContext {
  computerMode?: 'host' | 'cua'; conversation: boolean; unavailableConversation?: boolean; active?: boolean; needsApproval?: boolean;
  computer?: BotComputerReadiness; computerError?: string; checking?: boolean;
}
export interface BotReadiness { label: string; detail: string; tone: 'plain' | 'warn' | 'accent'; action?: 'settings' | 'computer' }

/** A provider being installed does not establish that an isolated computer is prepared. */
export function botReadiness(bot: Pick<Bot, 'paused' | 'available' | 'detail'>, context: BotReadinessContext): BotReadiness {
  if (context.unavailableConversation) return { label: 'Conversation unavailable', detail: 'Choose another conversation or start a new one.', tone: 'warn' };
  if (bot.paused) return { label: 'Paused', detail: 'Resume this bot when you want it to work.', tone: 'plain' };
  if (context.needsApproval) return { label: 'Needs approval', detail: 'Review the request in the shared conversation.', tone: 'warn' };
  if (context.active) return { label: 'Working', detail: 'Work is running in the shared conversation.', tone: 'accent' };
  if (context.computerMode === 'cua') {
    if (context.computer?.cleanupConfirmed === false) return { label: 'Computer needs attention', detail: context.computer.detail || 'Stop this isolated computer to confirm cleanup before continuing.', tone: 'warn', action: 'computer' };
    if (context.computerError || context.computer?.available === false) return { label: 'Computer setup needed', detail: context.computerError || context.computer?.detail || 'Prepare CUA on the selected computer before starting work.', tone: 'warn', action: 'settings' };
    if (!context.computer) return { label: context.checking ? 'Checking computer' : 'Computer not checked', detail: 'Computer setup is checked without starting a desktop or a task.', tone: 'plain', action: 'computer' };
    if (!context.conversation && bot.available === false) return { label: 'Setup needed', detail: bot.detail || 'Review the provider and execution computer before starting work.', tone: 'warn', action: 'settings' };
    return context.computer.running ? { label: 'Computer running', detail: context.computer.detail || 'The isolated desktop is running.', tone: 'accent', action: 'computer' } : { label: 'Computer stopped', detail: context.computer.detail || 'Start the isolated desktop from Computer when you want to work.', tone: 'plain', action: 'computer' };
  }
  // The current profile's availability cannot establish an old chat's frozen provider/target readiness.
  if (context.conversation) return { label: 'Idle', detail: 'Uses this conversation’s saved model and computer.', tone: 'plain' };
  if (bot.available === false) return { label: 'Setup needed', detail: bot.detail || 'Review the provider and execution computer before starting work.', tone: 'warn', action: 'settings' };
  if (bot.available === true) return { label: 'Available', detail: bot.detail || 'The configured provider and execution computer are available.', tone: 'plain' };
  return { label: 'Setup not checked', detail: 'Review the bot’s settings before starting work.', tone: 'plain', action: 'settings' };
}
