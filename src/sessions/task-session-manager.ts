export interface TaskSessionManager {
  startFarming(missionId?: string): void;
  recordCropPlanted(): number;
  recordFarmFailure(): { consecutiveFailures: number; shouldAbort: boolean };
  getPlantedCount(): number;
  startHunting(missionId?: string): void;
  recordAnimalAttacked(entityId: number): void;
  recordAnimalKilled(entityId: number): { counted: boolean; totalKilled: number };
  recordAnimalDead(entityId: number): boolean;
  getHuntedCount(): number;
  tryCompleteTask(
    missionId: string,
    reason: 'COMPLETED' | 'TIMEOUT'
  ): { completed: boolean; count: number };
  reset(): void;
}

const MAX_CONSECUTIVE_FARM_FAILURES = 5;

export function createTaskSessionManager(): TaskSessionManager {
  let activeTaskType: 'FARM' | 'HUNT' | null = null;
  let plantedCount = 0;
  let consecutiveFailures = 0;
  const attackedIds = new Set<number>();
  const killedIds = new Set<number>();
  let activeTargetId: number | null = null;
  const completedMissionIds = new Set<string>();

  return {
    startFarming(missionId?: string) {
      activeTaskType = 'FARM';
      plantedCount = 0;
      consecutiveFailures = 0;
      if (missionId) {
        completedMissionIds.delete(missionId);
      }
    },

    recordCropPlanted(): number {
      plantedCount++;
      consecutiveFailures = 0;
      return plantedCount;
    },

    recordFarmFailure(): { consecutiveFailures: number; shouldAbort: boolean } {
      consecutiveFailures++;
      return {
        consecutiveFailures,
        shouldAbort: consecutiveFailures >= MAX_CONSECUTIVE_FARM_FAILURES,
      };
    },

    getPlantedCount(): number {
      return plantedCount;
    },

    startHunting(missionId?: string) {
      activeTaskType = 'HUNT';
      attackedIds.clear();
      killedIds.clear();
      activeTargetId = null;
      if (missionId) {
        completedMissionIds.delete(missionId);
      }
    },

    recordAnimalAttacked(entityId: number) {
      attackedIds.add(entityId);
      activeTargetId = entityId;
    },

    recordAnimalKilled(entityId: number): { counted: boolean; totalKilled: number } {
      if (killedIds.has(entityId)) {
        return { counted: false, totalKilled: killedIds.size };
      }
      killedIds.add(entityId);
      return { counted: true, totalKilled: killedIds.size };
    },

    recordAnimalDead(entityId: number): boolean {
      if ((attackedIds.has(entityId) || activeTargetId === entityId) && !killedIds.has(entityId)) {
        killedIds.add(entityId);
        return true;
      }
      return false;
    },

    getHuntedCount(): number {
      return killedIds.size;
    },

    tryCompleteTask(
      missionId: string,
      _reason: 'COMPLETED' | 'TIMEOUT'
    ): { completed: boolean; count: number } {
      if (!missionId || completedMissionIds.has(missionId)) {
        return { completed: false, count: 0 };
      }
      completedMissionIds.add(missionId);

      const isHunt =
        missionId.startsWith('HUNT') ||
        (activeTaskType === 'HUNT' && !missionId.startsWith('FARM'));
      if (isHunt) {
        const count = killedIds.size;
        killedIds.clear();
        attackedIds.clear();
        activeTargetId = null;
        return { completed: true, count };
      }

      const count = plantedCount;
      return { completed: true, count };
    },

    reset() {
      activeTaskType = null;
      plantedCount = 0;
      consecutiveFailures = 0;
      attackedIds.clear();
      killedIds.clear();
      activeTargetId = null;
      completedMissionIds.clear();
    },
  };
}
