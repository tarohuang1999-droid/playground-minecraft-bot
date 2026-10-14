import type { RunnerEvent } from './bt/runner.ts';

export function parseCommand(owner: string, username: string, message: string): Exclude<RunnerEvent, { type: 'world' }> | null {
  if (username !== owner) return null;
  switch (message.trim().toLowerCase()) {
    case 'follow': return { type: 'intent', mode: 'FOLLOW' };
    case 'stop': return { type: 'intent', mode: 'STAY' };
    case 'status': return { type: 'status' };
    default: return null;
  }
}
