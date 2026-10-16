import type { IntentState } from './blackboard.ts';

export type CommandEvent =
  | { type: 'intent'; mode: IntentState['mode'] }
  | { type: 'status' }
  | { type: 'set_base' }
  | { type: 'come' }
  | { type: 'set_dig'; enabled: boolean }
  | { type: 'set_bridge'; enabled: boolean }
  | { type: 'item'; target: 'equipment' | 'inventory' }
  | { type: 'command_usage'; message: string }
  | { type: 'unknown'; raw: string };

export function parseCommand(
  owner: string,
  username: string,
  message: string
): CommandEvent | null {
  if (username.trim().toLowerCase() !== owner.trim().toLowerCase()) return null;
  const trimmed = message.trim();
  if (!trimmed.startsWith('!')) return null;

  const clean = trimmed.slice(1).trim().toLowerCase();
  const tokens = clean.split(/\s+/);
  const cmd = tokens[0];

  if (tokens.length === 1) {
    if (cmd === 'follow') return { type: 'intent', mode: 'FOLLOW' };
    if (cmd === 'stop' || cmd === 'unfollow') return { type: 'intent', mode: 'STAY' };
    if (cmd === 'status' || cmd === 'state') return { type: 'status' };
    if (cmd === 'base') return { type: 'set_base' };
    if (cmd === 'come') return { type: 'come' };
    if (cmd === 'return') return { type: 'intent', mode: 'RETURN' };
  }

  if (cmd === 'dig') {
    if (tokens.length === 2) {
      const arg = tokens[1];
      if (arg === 'on') return { type: 'set_dig', enabled: true };
      if (arg === 'off') return { type: 'set_dig', enabled: false };
    }
    return { type: 'command_usage', message: 'Usage: !dig on|off' };
  }

  if (cmd === 'bridge') {
    if (tokens.length === 2) {
      const arg = tokens[1];
      if (arg === 'on') return { type: 'set_bridge', enabled: true };
      if (arg === 'off') return { type: 'set_bridge', enabled: false };
    }
    return { type: 'command_usage', message: 'Usage: !bridge on|off' };
  }

  if (cmd === 'item') {
    if (tokens.length === 2) {
      const arg = tokens[1];
      if (arg === 'equipment' || arg === 'equip') return { type: 'item', target: 'equipment' };
      if (arg === 'inventory' || arg === 'inv') return { type: 'item', target: 'inventory' };
    }
    return { type: 'command_usage', message: 'Usage: !item equipment | !item inventory' };
  }

  return { type: 'unknown', raw: clean };
}
