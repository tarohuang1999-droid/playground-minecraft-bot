import type { BlackboardSnapshot } from '../../blackboard.ts';
import { survivalConfig } from '../../config/index.ts';
import { action, guard, reactiveSelector } from '../nodes.ts';

export function canSleep(s: BlackboardSnapshot): boolean {
  if (!s.world.self.isAlive || s.world.spawnPoint === null) return false;
  if (s.world.threats.length > 0 || s.world.self.tookDamageRecently) return false;

  // Active command !sleep: always allow going to sleep (even in daytime)
  if (s.intent.mode === 'SLEEP') return true;

  // Autonomous sleep: only when in IDLE or STAY, and during night or thunderstorm
  const isNightOrRain =
    s.world.isRaining ||
    (s.world.timeOfDay >= survivalConfig.sleepMinTime &&
      s.world.timeOfDay <= survivalConfig.sleepMaxTime);

  return (s.intent.mode === 'IDLE' || s.intent.mode === 'STAY') && isNightOrRain;
}

export function shouldExitSleep(s: BlackboardSnapshot, available: ReadonlySet<string>): boolean {
  if (!available.has('SleepAtBed') || !s.world.self.isAlive || s.world.spawnPoint === null) {
    return true;
  }
  if (s.world.self.tookDamageRecently || s.world.threats.length > 0) {
    return true;
  }

  // Active command !sleep: stay until morning arrives or cancelled by another command/attack
  if (s.intent.mode === 'SLEEP') {
    return false;
  }

  if (s.intent.mode !== 'IDLE' && s.intent.mode !== 'STAY') {
    return true;
  }

  const isNightOrRain =
    s.world.isRaining ||
    (s.world.timeOfDay >= survivalConfig.sleepMinTime &&
      s.world.timeOfDay <= survivalConfig.sleepMaxTime);

  return !isNightOrRain;
}

export function restSubtree(available: ReadonlySet<string>) {
  const sleepAtBed = guard(
    'SleepAtBed-ready',
    s => available.has('SleepAtBed') && canSleep(s),
    action('SleepAtBed', s => {
      const spawn = s.world.spawnPoint!;
      return {
        actionType: 'SleepAtBed',
        targetId: null,
        params: { x: spawn.x, y: spawn.y, z: spawn.z },
      };
    }),
    { exit: s => shouldExitSleep(s, available) }
  );

  return reactiveSelector('rest', [sleepAtBed]);
}
