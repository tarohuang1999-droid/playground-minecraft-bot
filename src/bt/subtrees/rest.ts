import type { BlackboardSnapshot } from '../../blackboard.ts';
import { survivalConfig } from '../../config/index.ts';
import { action, guard, reactiveSelector } from '../nodes.ts';

export function canSleep(s: BlackboardSnapshot): boolean {
  return (
    s.world.self.isAlive &&
    s.intent.mode === 'IDLE' &&
    s.world.spawnPoint !== null &&
    (s.world.isRaining ||
      (s.world.timeOfDay >= survivalConfig.sleepMinTime &&
        s.world.timeOfDay <= survivalConfig.sleepMaxTime)) &&
    s.world.threats.length === 0 &&
    !s.world.self.tookDamageRecently
  );
}

export function shouldExitSleep(s: BlackboardSnapshot, available: ReadonlySet<string>): boolean {
  return (
    !available.has('SleepAtBed') ||
    !s.world.self.isAlive ||
    s.intent.mode !== 'IDLE' ||
    s.world.spawnPoint === null ||
    s.world.self.tookDamageRecently ||
    s.world.threats.length > 0 ||
    (!s.world.isRaining &&
      (s.world.timeOfDay < survivalConfig.sleepMinTime ||
        s.world.timeOfDay > survivalConfig.sleepMaxTime))
  );
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
