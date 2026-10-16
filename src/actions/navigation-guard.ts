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

export interface NavigationTaskState {
  missionId: string;
  canDig: boolean;
  allowBridge: boolean;
  digQuota: number;
  placeQuota: number;
}

export function createNavigationTaskState(missionId: string, canDig = false, allowBridge = false): NavigationTaskState {
  return {
    missionId,
    canDig,
    allowBridge,
    digQuota: 3,
    placeQuota: 3,
  };
}

export interface NavigationRunContext {
  readonly token: number;
  readonly generation: number;
  readonly canDig: boolean;
  readonly allowBridge: boolean;
  readonly taskState: NavigationTaskState;
  isActive(): boolean;
}

export class NavigationExecutionBoundary {
  private activeContext: NavigationRunContext | null = null;
  private inFlightDigs = 0;
  private inFlightPlaces = 0;
  private originalDig: any = null;
  private originalPlaceBlock: any = null;

  install(bot: any) {
    if (!bot || this.originalDig) return;
    this.originalDig = bot.dig;
    this.originalPlaceBlock = bot.placeBlock;

    bot.dig = async (block: any, force?: boolean) => {
      const ctx = this.activeContext;
      if (!ctx || !ctx.isActive()) {
        throw new Error('Dig rejected: navigation run is not active');
      }
      if (!ctx.canDig || !ctx.taskState.canDig) {
        throw new Error('Dig rejected: dig capability is disabled');
      }
      if (!block || !block.name || !DIG_WHITELIST.has(block.name)) {
        throw new Error(`Dig rejected: block ${block?.name} is not in dig whitelist`);
      }
      if (ctx.taskState.digQuota <= 0) {
        throw new Error('Dig rejected: dig quota exhausted');
      }

      // Deduct quota before operation dispatch; failure does not refund
      ctx.taskState.digQuota--;

      this.inFlightDigs++;
      try {
        if (typeof this.originalDig === 'function') {
          return await this.originalDig.call(bot, block, force);
        }
      } finally {
        this.inFlightDigs--;
      }
    };

    bot.placeBlock = async (referenceBlock: any, faceVector: any) => {
      const ctx = this.activeContext;
      if (!ctx || !ctx.isActive()) {
        throw new Error('Place rejected: navigation run is not active');
      }
      if (!ctx.allowBridge || !ctx.taskState.allowBridge) {
        throw new Error('Place rejected: bridge capability is disabled');
      }
      const held = bot.heldItem;
      if (held && !PLACE_WHITELIST.has(held.name)) {
        throw new Error(`Place rejected: held item ${held.name} is not in place whitelist`);
      }
      if (ctx.taskState.placeQuota <= 0) {
        throw new Error('Place rejected: place quota exhausted');
      }

      // Deduct quota before operation dispatch; failure does not refund
      ctx.taskState.placeQuota--;

      this.inFlightPlaces++;
      try {
        if (typeof this.originalPlaceBlock === 'function') {
          return await this.originalPlaceBlock.call(bot, referenceBlock, faceVector);
        }
      } finally {
        this.inFlightPlaces--;
      }
    };
  }

  setActiveContext(ctx: NavigationRunContext | null) {
    this.activeContext = ctx;
  }

  getActiveContext(): NavigationRunContext | null {
    return this.activeContext;
  }

  getDigQuota(): number {
    return this.activeContext?.taskState.digQuota ?? 0;
  }

  getPlaceQuota(): number {
    return this.activeContext?.taskState.placeQuota ?? 0;
  }

  isInFlight(): boolean {
    return this.inFlightDigs > 0 || this.inFlightPlaces > 0;
  }

  uninstall(bot: any) {
    if (this.originalDig && bot) {
      bot.dig = this.originalDig;
      this.originalDig = null;
    }
    if (this.originalPlaceBlock && bot) {
      bot.placeBlock = this.originalPlaceBlock;
      this.originalPlaceBlock = null;
    }
    this.activeContext = null;
    this.inFlightDigs = 0;
    this.inFlightPlaces = 0;
  }
}
