import type { IntentState } from './blackboard.ts';

export type CommandEvent =
  | { type: 'intent'; mode: IntentState['mode'] }
  | { type: 'status' }
  | { type: 'set_base' }
  | { type: 'come' }
  | { type: 'unknown'; raw: string };

export function parseCommand(owner: string, username: string, message: string): CommandEvent | null {
  if (username.trim().toLowerCase() !== owner.trim().toLowerCase()) return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith('!')) return null;

  const clean = trimmed.slice(1).trim().toLowerCase();
  switch (clean) {
    case 'follow': return { type: 'intent', mode: 'FOLLOW' };
    case 'stop':
    case 'unfollow': return { type: 'intent', mode: 'STAY' };
    case 'status':
    case 'state': return { type: 'status' };
    case 'base': return { type: 'set_base' };
    case 'come': return { type: 'come' };
    default: return { type: 'unknown', raw: clean };
  }
}

