export const survivalConfig = {
  routineFood: 16,
  emergencyFood: 6,
  emergencyHealth: 10,
  sleepMinTime: 12541, // Sunset / bed time begins in ticks
  sleepMaxTime: 23458, // Dawn / wake up time in ticks
  bed: {
    searchRadius: 10,
    reachDistance: 2.5,
    approachGoal: 2.0,
    sleepReachDistance: 2.0,
    sleepApproachGoal: 1.8,
    setBedTimeoutMs: 30_000,
    failureCooldownMs: 60_000,
  },
} as const;
