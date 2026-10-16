export interface CropDefinition {
  seedItem: string;
  blockName: string;
  matureAge: number;
  dropItem: string;
}

export const CROP_REGISTRY: Record<string, CropDefinition> = {
  wheat: {
    seedItem: 'wheat_seeds',
    blockName: 'wheat',
    matureAge: 7,
    dropItem: 'wheat',
  },
  carrot: {
    seedItem: 'carrot',
    blockName: 'carrots',
    matureAge: 7,
    dropItem: 'carrot',
  },
  potato: {
    seedItem: 'potato',
    blockName: 'potatoes',
    matureAge: 7,
    dropItem: 'potato',
  },
  beetroot: {
    seedItem: 'beetroot_seeds',
    blockName: 'beetroots',
    matureAge: 3,
    dropItem: 'beetroot',
  },
};

export const workConfig = {
  // Pickup
  pickupRadius: 5,
  pickupMasterLimit: 10,
  pickupGoalDistance: 0.2,
  pickupNearStepDistance: 1.5,
  pickupTimeoutMs: 5000,
  failureCooldownMs: 30_000,

  // Hunting
  huntTargetAnimals: ['chicken', 'pig', 'cow', 'sheep'] as const,
  huntWorkDiameter: 50,
  huntWorkRadius: 25,
  huntMaxDurationMs: 1_200_000, // 20 minutes (1 Minecraft day = 24,000 ticks)

  // Farming & Harvesting
  crops: CROP_REGISTRY,
  defaultCrop: 'wheat',
  farmWorkDiameter: 50,
  farmWorkRadius: 25,
  farmMaxDurationMs: 1_200_000, // 20 minutes (1 Minecraft day)
  avoidJumpingOnFarmland: true,

  // Container & Chests
  boxMaxInteractionDistance: 3.5,
  defaultPreservedItems: [
    'sword',
    'shield',
    'bow',
    'arrow',
    'bread',
    'cooked_beef',
    'cooked_porkchop',
  ] as const,
} as const;
