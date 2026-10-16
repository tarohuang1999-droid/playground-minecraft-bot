export const DIG_WHITELIST: ReadonlySet<string> = new Set([
  // Dirt & soil
  'dirt',
  'grass_block',
  'coarse_dirt',
  'podzol',
  'mud',
  // Sand & gravel
  'sand',
  'red_sand',
  'gravel',
  // Foliage & leaves
  'oak_leaves',
  'birch_leaves',
  'spruce_leaves',
  'jungle_leaves',
  'acacia_leaves',
  'dark_oak_leaves',
  'mangrove_leaves',
  'cherry_leaves',
  'azalea_leaves',
  'flowering_azalea_leaves',
  'vine',
  // Stone
  'cobblestone',
]);

export const PLACE_WHITELIST: ReadonlySet<string> = new Set([
  'dirt',
  'cobblestone',
]);

export const navigationConfig = {
  followEnter: 2.2,
  followExit: 1.2,
  catchUpEnter: 16,
  catchUpExit: 5,
  comeOnceRange: 1.5,
  returnBaseRange: 2.0,
  stallThresholdMs: 1500,
  recoveryMaxRetries: 2,
  defaultCanDig: false,
  defaultAllowBridge: false,
  allowParkour: false,
  allowSprinting: true,
  maxDigQuota: 3,
  maxPlaceQuota: 3,
  digWhitelist: DIG_WHITELIST,
  placeWhitelist: PLACE_WHITELIST,
} as const;
