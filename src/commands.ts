import type { RunnerEvent } from './bt/runner.ts';

export function parseCommand(owner: string, username: string, message: string): Exclude<RunnerEvent, { type: 'world' }> | null {
  if (username.trim().toLowerCase() !== owner.trim().toLowerCase()) return null;
  const clean = message.trim().toLowerCase().replace(/^\//, '');
  switch (clean) {
    case 'follow': return { type: 'intent', mode: 'FOLLOW' };
    case 'stop':
    case 'unfollow': return { type: 'intent', mode: 'STAY' };
    case 'status': return { type: 'status' };
    default: return null;
  }
}
