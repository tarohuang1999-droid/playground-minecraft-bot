import { DIG_WHITELIST, PLACE_WHITELIST } from '../config/navigation.config.ts';

export { DIG_WHITELIST, PLACE_WHITELIST };

export interface NavigationTaskState {
  missionId: string;
  canDig: boolean;
  allowBridge: boolean;
  digQuota: number;
  placeQuota: number;
}

export function createNavigationTaskState(
  missionId: string,
  canDig = false,
  allowBridge = false
): NavigationTaskState {
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

export interface GuardableBot {
  dig?: ((block: { name?: string }, force?: boolean) => Promise<unknown>) | undefined;
  placeBlock?: ((referenceBlock: unknown, faceVector: unknown) => Promise<unknown>) | undefined;
  heldItem?: { name: string } | null | undefined;
}

export class NavigationExecutionBoundary {
  private activeContext: NavigationRunContext | null = null;
  private inFlightDigs = 0;
  private inFlightPlaces = 0;
  private installed = false;
  private originalDig: ((block: { name?: string }, force?: boolean) => Promise<unknown>) | null =
    null;
  private originalPlaceBlock:
    ((referenceBlock: unknown, faceVector: unknown) => Promise<unknown>) | null = null;

  install(bot: GuardableBot) {
    if (!bot || this.installed) return;
    this.installed = true;
    this.originalDig = bot.dig ?? null;
    this.originalPlaceBlock = bot.placeBlock ?? null;

    bot.dig = async (block: { name?: string }, force?: boolean) => {
      const ctx = this.activeContext;
      if (!ctx) {
        if (typeof this.originalDig === 'function') {
          return await this.originalDig.call(bot, block, force);
        }
        return;
      }
      if (!ctx.isActive()) {
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

    bot.placeBlock = async (referenceBlock: unknown, faceVector: unknown) => {
      const ctx = this.activeContext;
      if (!ctx) {
        if (typeof this.originalPlaceBlock === 'function') {
          return await this.originalPlaceBlock.call(bot, referenceBlock, faceVector);
        }
        return;
      }
      if (!ctx.isActive()) {
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

  uninstall(bot: GuardableBot) {
    if (!this.installed) return;
    if (bot) {
      if (this.originalDig) {
        bot.dig = this.originalDig;
      } else {
        delete bot.dig;
      }
      if (this.originalPlaceBlock) {
        bot.placeBlock = this.originalPlaceBlock;
      } else {
        delete bot.placeBlock;
      }
    }
    this.installed = false;
    this.originalDig = null;
    this.originalPlaceBlock = null;
    this.activeContext = null;
    this.inFlightDigs = 0;
    this.inFlightPlaces = 0;
  }
}
