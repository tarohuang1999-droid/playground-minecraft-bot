import { createWorld, type Position, type WorldState } from './blackboard.ts';
import { THRESHOLDS } from './policy.ts';

export const ARMOR_SLOTS = {
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
} as const;
export type ArmorSlot = keyof typeof ARMOR_SLOTS;

export const ARMOR_TIERS: Record<string, number> = {
  leather: 1,
  golden: 2,
  gold: 2,
  chainmail: 3,
  iron: 4,
  turtle: 4,
  diamond: 5,
  netherite: 6,
};

export function getArmorInfo(name: string): { slot: ArmorSlot; tier: number } | null {
  const lower = name.toLowerCase();
  let slot: ArmorSlot | null = null;
  if (lower.endsWith('_helmet') || lower === 'turtle_helmet') slot = 'head';
  else if (lower.endsWith('_chestplate') || lower === 'elytra') slot = 'torso';
  else if (lower.endsWith('_leggings')) slot = 'legs';
  else if (lower.endsWith('_boots')) slot = 'feet';

  if (!slot) return null;
  for (const [mat, tier] of Object.entries(ARMOR_TIERS)) {
    if (lower.startsWith(mat)) return { slot, tier };
  }
  return { slot, tier: 1 };
}

export const FOOD_POINTS: Record<string, number> = {
  enchanted_golden_apple: 20,
  golden_apple: 16,
  golden_carrot: 14,
  cooked_porkchop: 12,
  cooked_beef: 12,
  steak: 12,
  cooked_mutton: 10,
  cooked_salmon: 10,
  bread: 8,
  cooked_chicken: 8,
  cooked_cod: 8,
  baked_potato: 8,
  mushroom_stew: 8,
  rabbit_stew: 10,
  beetroot_soup: 6,
  cooked_rabbit: 6,
  apple: 4,
  carrot: 4,
  sweet_berries: 2,
  melon_slice: 2,
  cookie: 2,
  honey_bottle: 6,
};

const HARMFUL_FOODS = new Set([
  'rotten_flesh',
  'spider_eye',
  'poisonous_potato',
  'pufferfish',
  'chorus_fruit',
]);

export function getFoodPoints(name: string): number {
  const lower = name.toLowerCase();
  if (HARMFUL_FOODS.has(lower)) return 0;
  return FOOD_POINTS[lower] ?? 0;
}

export const WEAPON_TIERS: Record<string, number> = {
  wooden: 1,
  wood: 1,
  golden: 1,
  gold: 1,
  stone: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

export function getWeaponDamage(name: string): number {
  const lower = name.toLowerCase();
  for (const [mat, tier] of Object.entries(WEAPON_TIERS)) {
    if (lower.startsWith(mat)) {
      if (lower.endsWith('_sword')) return tier * 2 + 3;
      if (lower.endsWith('_axe')) return tier * 2 + 2;
    }
  }
  return 0;
}

interface VisibleEntity {
  id: number;
  position: Position;
  name?: string;
  username?: string;
  displayName?: string;
  type?: string;
  health?: number;
  isValid?: boolean;
  getDroppedItem?: () => { name: string } | null;
}
export interface PerceptionSource {
  entity: VisibleEntity;
  health: number;
  food: number;
  entities: Record<string, VisibleEntity>;
  players: Record<string, { entity?: VisibleEntity; username?: string }>;
  inventory: {
    emptySlotCount(): number;
    items?(): any[];
    slots?: any[];
  };
  heldItem?: any;
  quickBarSlot?: number;
}
export const HOSTILE_MOBS: ReadonlySet<string> = new Set([
  'zombie',
  'zombie_villager',
  'drowned',
  'husk',
  'skeleton',
  'stray',
  'wither_skeleton',
  'spider',
  'cave_spider',
  'creeper',
  'enderman',
  'witch',
  'slime',
  'magma_cube',
  'silverfish',
  'endermite',
  'blaze',
  'ghast',
  'phantom',
  'pillager',
  'vindicator',
  'evoker',
  'vex',
  'ravager',
  'shulker',
  'guardian',
  'elder_guardian',
  'piglin_brute',
  'zombified_piglin',
  'hoglin',
  'zoglin',
  'warden',
  'wither',
  'ender_dragon',
]);

export function isHostileMob(entity: { name?: string; username?: string; type?: string; displayName?: string }): boolean {
  if (!entity) return false;
  // [RULE-08] Never attack players or master
  if (entity.type === 'player' || entity.username) return false;
  const name = (entity.name ?? entity.displayName ?? '').toLowerCase();
  return HOSTILE_MOBS.has(name);
}

const position = (value: Position): Position => ({ x: value.x, y: value.y, z: value.z });
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export interface DynamicHostileTarget {
  entityId: number;
  username?: string | undefined;
  name?: string | undefined;
  expiresAt: number;
  maxHits?: number | undefined;
  hitsDone: number;
  isOwner: boolean;
}

export function createPerception(bot: PerceptionSource, owner: string, options: { now?: () => number } = {}) {
  let lastHealth = bot.health;
  let lastDamageTime = 0;
  const dynamicThreats = new Map<number, DynamicHostileTarget>();
  let currentBase: Position | null = null;
  let currentSpawnPoint: Position | null = null;
  let bedNeedsRefresh = false;
  let bedCooldownUntil = 0;

  const getNow = () => (options.now ? options.now() : Date.now());

  return {
    setBase(pos: Position) {
      currentBase = { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 };
      bedNeedsRefresh = true;
      bedCooldownUntil = 0;
    },

    getBase(): Position | null {
      return currentBase ? { ...currentBase } : null;
    },

    setSpawnPoint(pos: Position) {
      currentSpawnPoint = { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 };
      bedNeedsRefresh = false;
    },

    getSpawnPoint(): Position | null {
      return currentSpawnPoint ? { ...currentSpawnPoint } : null;
    },

    isBedRefreshNeeded(): boolean {
      return bedNeedsRefresh;
    },

    clearBedRefreshNeeded() {
      bedNeedsRefresh = false;
    },

    setBedCooldown(durationMs: number) {
      bedCooldownUntil = getNow() + durationMs;
    },

    clearBedCooldown() {
      bedCooldownUntil = 0;
    },

    recordAttacker(
      entity: { id: number; username?: string; name?: string },
      config: { durationMs: number; maxHits?: number; isOwner: boolean }
    ) {
      const now = getNow();
      dynamicThreats.set(entity.id, {
        entityId: entity.id,
        username: entity.username,
        name: entity.name ?? entity.username,
        expiresAt: now + config.durationMs,
        maxHits: config.maxHits,
        hitsDone: 0,
        isOwner: config.isOwner,
      });
    },

    notifyAttack(targetId: number) {
      const threat = dynamicThreats.get(targetId);
      if (!threat) return;
      threat.hitsDone++;
      if (threat.maxHits !== undefined && threat.hitsDone >= threat.maxHits) {
        dynamicThreats.delete(targetId);
      }
    },

    isThreat(entityId: number): boolean {
      return dynamicThreats.has(entityId);
    },

    clearDynamicThreats() {
      dynamicThreats.clear();
    },

    sample(cooldowns?: Record<number, number>): WorldState {
      const world = createWorld(owner);
      const origin = bot.entity.position;
      const now = getNow();
      if (bot.health < lastHealth) {
        lastDamageTime = now;
      }
      lastHealth = bot.health;
      const tookDamageRecently = (now - lastDamageTime) < 2000;
      world.self = { position: position(origin), health: bot.health, food: bot.food, isAlive: bot.health > 0, tookDamageRecently };
      world.base = currentBase ? { ...currentBase } : null;
      world.spawnPoint = currentSpawnPoint ? { ...currentSpawnPoint } : null;
      world.bedNeedsRefresh = bedNeedsRefresh;
      world.nearbyBed = null;

      if (bedCooldownUntil <= now && (currentSpawnPoint === null || bedNeedsRefresh)) {
        const centerPos = currentBase ?? origin;
        if (centerPos && typeof (bot as any).findBlock === 'function') {
          const bedBlock = (bot as any).findBlock({
            matching: (b: any) => b?.name?.includes('bed'),
            maxDistance: 24,
            point: centerPos,
          });
          if (bedBlock && bedBlock.position) {
            world.nearbyBed = position(bedBlock.position);
          }
        } else if (centerPos && (bot as any).blocks) {
          for (const b of Object.values((bot as any).blocks as Record<string, any>)) {
            if (b?.name?.includes('bed') && b?.position) {
              const d = distance(centerPos, b.position);
              if (d <= 24) {
                world.nearbyBed = position(b.position);
                break;
              }
            }
          }
        }
      }

      // Prune expired dynamic threats
      for (const [id, threat] of dynamicThreats.entries()) {
        if (threat.expiresAt <= now) {
          dynamicThreats.delete(id);
        }
      }

      let master = bot.players[owner]?.entity;
      const matchKey = Object.keys(bot.players).find(k => k.toLowerCase() === owner.toLowerCase());
      if (!master && matchKey) master = bot.players[matchKey]?.entity;
      if (!master && (bot.players[owner] || matchKey) && bot.entities) {
        const matchEntity = Object.values(bot.entities).find(e => (e.username ?? e.name ?? '').toLowerCase() === owner.toLowerCase());
        if (matchEntity) master = matchEntity;
      }
      if (master) world.master = { username: owner, entityId: master.id, position: position(master.position), distance: distance(origin, master.position) };
      for (const entity of Object.values(bot.entities)) {
        if (!entity?.position) continue;
        if (entity.id === bot.entity.id) continue;
        const range = distance(origin, entity.position);
        if (range > THRESHOLDS.observationRadius) continue;
        world.entities.push({ entityId: entity.id, name: entity.name ?? entity.username ?? 'unknown', position: position(entity.position), distance: range });

        const isDynamic = dynamicThreats.has(entity.id);
        if (isHostileMob(entity as any) || isDynamic) {
          const isValid = (entity as any).isValid !== false;
          const health = (entity as any).health;
          const isAlive = health === undefined || health > 0;
          if (isValid && isAlive && range <= THRESHOLDS.combatExit) {
            world.threats.push({
              entityId: entity.id,
              name: entity.name ?? entity.displayName ?? (isDynamic ? (entity.username ?? 'player') : 'hostile'),
              position: position(entity.position),
              distance: range,
            });
          }
        }

        const isItem = entity.name === 'item' || entity.name === 'Item' || entity.name === 'item_stack';
        if (isItem && range <= THRESHOLDS.pickupRadius) {
          const cooldownUntil = cooldowns?.[entity.id];
          if (cooldownUntil && cooldownUntil > now) continue;
          const itemName = entity.getDroppedItem?.()?.name ?? entity.displayName ?? entity.name ?? 'item';
          world.nearbyDrops.push({
            entityId: entity.id,
            name: entity.name ?? 'item',
            position: position(entity.position),
            distance: range,
            itemName,
          });
        }
      }
      world.entities.sort((a, b) => a.distance - b.distance || a.entityId - b.entityId);
      world.threats.sort((a, b) => a.distance - b.distance || a.entityId - b.entityId);
      world.nearbyDrops.sort((a, b) => a.distance - b.distance || a.entityId - b.entityId);
      world.inventory.freeSlots = bot.inventory.emptySlotCount();

      // Inventory item scanning:
      const items = typeof bot.inventory.items === 'function' ? bot.inventory.items() : [];
      const slots = bot.inventory.slots ?? [];

      // 1. Food scoring:
      let bestFood: { itemId: number; name: string; foodPoints: number } | null = null;
      for (const item of items) {
        if (!item?.name) continue;
        const pts = getFoodPoints(item.name);
        if (pts > 0 && (!bestFood || pts > bestFood.foodPoints)) {
          bestFood = { itemId: item.type ?? item.id, name: item.name, foodPoints: pts };
        }
      }
      world.inventory.bestFood = bestFood;

      // 2. Armor upgrades:
      let pendingArmorUpgrade: { itemId: number; slot: ArmorSlot } | null = null;
      let highestUpgradeDiff = 0;
      for (const [slotKey, slotIndex] of Object.entries(ARMOR_SLOTS) as Array<[ArmorSlot, number]>) {
        const equipped = slots[slotIndex];
        const equippedTier = equipped ? (getArmorInfo(equipped.name)?.tier ?? 0) : 0;
        for (const item of items) {
          if (!item?.name || item.slot === slotIndex) continue;
          const info = getArmorInfo(item.name);
          if (info && info.slot === slotKey && info.tier > equippedTier) {
            const diff = info.tier - equippedTier;
            if (diff > highestUpgradeDiff) {
              highestUpgradeDiff = diff;
              pendingArmorUpgrade = { itemId: item.type ?? item.id, slot: slotKey };
            }
          }
        }
      }
      world.inventory.pendingArmorUpgrade = pendingArmorUpgrade;

      // 3. Weapon scoring:
      let bestWeapon: { itemId: number; name: string; attackDamage: number } | null = null;
      for (const item of items) {
        if (!item?.name) continue;
        const dmg = getWeaponDamage(item.name);
        if (dmg > 0 && (!bestWeapon || dmg > bestWeapon.attackDamage)) {
          bestWeapon = { itemId: item.type ?? item.id, name: item.name, attackDamage: dmg };
        }
      }
      world.inventory.bestWeapon = bestWeapon;

      const held = bot.heldItem ?? slots[36 + (bot.quickBarSlot ?? 0)];
      world.inventory.equippedWeaponDamage = held ? getWeaponDamage(held.name) : 0;

      return world;
    },
  };
}
