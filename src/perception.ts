import { createWorld, type Position, type WorldState } from './blackboard.ts';
import { THRESHOLDS, CROP_REGISTRY, workConfig, survivalConfig } from './config/index.ts';
import { Vec3 } from 'vec3';
import { loadPersistentState, savePersistentState } from './state-storage.ts';

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
  time?: { timeOfDay?: number };
  isRaining?: boolean;
  isSleeping?: boolean;
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

export function isHostileMob(entity: {
  name?: string;
  username?: string;
  type?: string;
  displayName?: string;
}): boolean {
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

export function isBedBlock(b: any): boolean {
  if (!b || !b.name) return false;
  if (b.name === 'bedrock') return false;
  return b.name.endsWith('_bed') || b.name === 'bed';
}

export function isAvailableBed(b: any): boolean {
  if (!isBedBlock(b)) return false;
  const props = typeof b.getProperties === 'function' ? b.getProperties() : b._properties;
  if (props && (props.occupied === 'true' || props.occupied === true)) return false;
  return true;
}

export function findNearbyBed(
  bot: any,
  maxDistance: number = survivalConfig.bed.searchRadius,
  center?: Position
): any | null {
  const centerPos = center ?? bot.entity?.position;
  if (!centerPos) return null;

  if (typeof bot.findBlock === 'function') {
    const point = new Vec3(centerPos.x, centerPos.y, centerPos.z);
    const bedBlock = bot.findBlock({
      matching: (b: any) => isAvailableBed(b),
      maxDistance,
      point,
    });
    if (bedBlock) return bedBlock;
  }

  if (bot.blocks) {
    for (const b of Object.values(bot.blocks as Record<string, any>)) {
      if (isAvailableBed(b) && b?.position) {
        const d = Math.hypot(
          centerPos.x - b.position.x,
          centerPos.y - b.position.y,
          centerPos.z - b.position.z
        );
        if (d <= maxDistance) {
          return b;
        }
      }
    }
  }

  return null;
}

export interface PerceptionOptions {
  now?: (() => number) | undefined;
  storagePath?: string | undefined;
}

export function createPerception(
  bot: PerceptionSource,
  owner?: string,
  options: PerceptionOptions = {}
) {
  let lastHealth = bot.health;
  let lastDamageTime = -10000;
  const dynamicThreats = new Map<number, DynamicHostileTarget>();

  const initialSaved = options.storagePath
    ? loadPersistentState(options.storagePath)
    : { base: null, spawnPoint: null };
  let currentBase: Position | null = initialSaved.base;
  let currentSpawnPoint: Position | null = initialSaved.spawnPoint;
  let bedNeedsRefresh = false;
  let bedCooldownUntil = 0;
  const farmlandCooldowns = new Map<string, number>();
  const animalCooldowns = new Map<number, number>();

  const persist = () => {
    if (options.storagePath) {
      savePersistentState(
        { base: currentBase, spawnPoint: currentSpawnPoint },
        options.storagePath
      );
    }
  };

  const getNow = () => (options.now ? options.now() : Date.now());

  return {
    setBase(pos: Position) {
      currentBase = {
        x: Math.round(pos.x * 10) / 10,
        y: Math.round(pos.y * 10) / 10,
        z: Math.round(pos.z * 10) / 10,
      };
      bedNeedsRefresh = true;
      bedCooldownUntil = 0;
      persist();
    },

    getBase(): Position | null {
      return currentBase ? { ...currentBase } : null;
    },

    setSpawnPoint(pos: Position) {
      currentSpawnPoint = {
        x: Math.round(pos.x * 10) / 10,
        y: Math.round(pos.y * 10) / 10,
        z: Math.round(pos.z * 10) / 10,
      };
      bedNeedsRefresh = false;
      persist();
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
      entity: { id: number; username?: string | undefined; name?: string | undefined },
      config: { durationMs: number; maxHits?: number | undefined; isOwner: boolean }
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
      const tookDamageRecently = now - lastDamageTime < 2000;
      world.self = {
        position: position(origin),
        health: bot.health,
        food: bot.food,
        isAlive: bot.health > 0,
        tookDamageRecently,
      };
      world.base = currentBase ? { ...currentBase } : null;
      world.spawnPoint = currentSpawnPoint ? { ...currentSpawnPoint } : null;
      world.bedNeedsRefresh = bedNeedsRefresh;
      world.nearbyBed = null;
      world.timeOfDay = bot.time?.timeOfDay ?? 0;
      world.isRaining = Boolean(bot.isRaining);
      world.isSleeping = Boolean(bot.isSleeping);

      // Stage 13 / SetSpawn 依使用者需求：先改成 set base 才觸發，先註解 idle 自動執行
      const hasOwner = !!owner && owner.trim().length > 0;
      // [註解] 原先 idle 自動找床：const shouldSearchBed = hasOwner ? (currentBase !== null) : true;
      // [註解] 原先判斷：if (shouldSearchBed && bedCooldownUntil <= now && (currentSpawnPoint === null || bedNeedsRefresh)) {
      // 改為：有主人時僅在 set base 標記 bedNeedsRefresh 時才觸發；無主人時維持 currentSpawnPoint === null 自動找床
      const shouldSearchBed = hasOwner ? bedNeedsRefresh : currentSpawnPoint === null;

      if (shouldSearchBed && bedCooldownUntil <= now) {
        const centerPos = currentBase ?? origin;
        if (centerPos && typeof (bot as any).findBlock === 'function') {
          const point = new Vec3(centerPos.x, centerPos.y, centerPos.z);
          const bedBlock = (bot as any).findBlock({
            matching: (b: any) => isAvailableBed(b),
            maxDistance: 24,
            point,
          });
          if (bedBlock && bedBlock.position) {
            world.nearbyBed = position(bedBlock.position);
          }
        } else if (centerPos && (bot as any).blocks) {
          for (const b of Object.values((bot as any).blocks as Record<string, any>)) {
            if (isAvailableBed(b) && b?.position) {
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

      if (owner && owner.trim().length > 0) {
        let master = bot.players[owner]?.entity;
        const matchKey = Object.keys(bot.players).find(
          k => k.toLowerCase() === owner.toLowerCase()
        );
        if (!master && matchKey) master = bot.players[matchKey]?.entity;
        if (!master && (bot.players[owner] || matchKey) && bot.entities) {
          const matchEntity = Object.values(bot.entities).find(
            e => (e.username ?? e.name ?? '').toLowerCase() === owner.toLowerCase()
          );
          if (matchEntity) master = matchEntity;
        }
        if (master)
          world.master = {
            username: owner,
            entityId: master.id,
            position: position(master.position),
            distance: distance(origin, master.position),
          };
      }
      for (const entity of Object.values(bot.entities)) {
        if (!entity?.position) continue;
        if (entity.id === bot.entity.id) continue;
        const range = distance(origin, entity.position);
        if (range > THRESHOLDS.observationRadius) continue;
        world.entities.push({
          entityId: entity.id,
          name: entity.name ?? entity.username ?? 'unknown',
          position: position(entity.position),
          distance: range,
        });

        const isDynamic = dynamicThreats.has(entity.id);
        if (isHostileMob(entity as any) || isDynamic) {
          const isValid = (entity as any).isValid !== false;
          const health = (entity as any).health;
          const isAlive = health === undefined || health > 0;
          if (isValid && isAlive && range <= THRESHOLDS.combatExit) {
            world.threats.push({
              entityId: entity.id,
              name:
                entity.name ??
                entity.displayName ??
                (isDynamic ? (entity.username ?? 'player') : 'hostile'),
              position: position(entity.position),
              distance: range,
            });
          }
        }

        const isItem =
          entity.name === 'item' || entity.name === 'Item' || entity.name === 'item_stack';
        if (isItem && range <= THRESHOLDS.pickupRadius) {
          const cooldownUntil = cooldowns?.[entity.id];
          if (cooldownUntil && cooldownUntil > now) continue;
          const itemName =
            entity.getDroppedItem?.()?.name ?? entity.displayName ?? entity.name ?? 'item';
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
      for (const [slotKey, slotIndex] of Object.entries(ARMOR_SLOTS) as Array<
        [ArmorSlot, number]
      >) {
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
      world.inventory.heldItemName = held?.name ?? null;
      world.inventory.equippedWeaponDamage = held ? getWeaponDamage(held.name) : 0;

      // 4. Plantable seeds:
      const plantableSeeds: Array<{ name: string; count: number; cropType: string }> = [];
      const seedCounts = new Map<string, { count: number; cropType: string }>();
      for (const [cropKey, def] of Object.entries(CROP_REGISTRY)) {
        for (const item of items) {
          if (item && item.name === def.seedItem) {
            const cnt = item.count ?? 1;
            const existing = seedCounts.get(item.name);
            if (existing) {
              existing.count += cnt;
            } else {
              seedCounts.set(item.name, { count: cnt, cropType: cropKey });
            }
          }
        }
      }
      for (const [name, info] of seedCounts) {
        plantableSeeds.push({ name, count: info.count, cropType: info.cropType });
      }
      world.inventory.plantableSeeds = plantableSeeds;

      return world;
    },

    markFarmlandCooldown(pos: Position, durationMs = 30_000) {
      const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      farmlandCooldowns.set(key, getNow() + durationMs);
    },

    clearFarmlandCooldowns() {
      farmlandCooldowns.clear();
    },

    getAvailableFarmland(rallyPoint: Position, maxRadius: number = 25): Position | null {
      const now = getNow();
      for (const [key, exp] of farmlandCooldowns.entries()) {
        if (now >= exp) farmlandCooldowns.delete(key);
      }
      const isCooldown = (x: number, y: number, z: number) => {
        const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
        const exp = farmlandCooldowns.get(key);
        return exp !== undefined && now < exp;
      };
      return findAvailableFarmland(bot, rallyPoint, maxRadius, isCooldown);
    },

    markAnimalCooldown(entityId: number, durationMs = 30_000) {
      animalCooldowns.set(entityId, getNow() + durationMs);
    },

    clearAnimalCooldowns() {
      animalCooldowns.clear();
    },

    getHuntableAnimal(
      rallyPoint: Position,
      maxRadius: number = 25,
      targetAnimal?: string | null,
      currentTargetId?: number | null
    ): { entityId: number; name: string; position: Position; distance: number } | null {
      const now = getNow();
      for (const [id, exp] of animalCooldowns.entries()) {
        if (now >= exp) animalCooldowns.delete(id);
      }
      const isCooldown = (id: number) => {
        const exp = animalCooldowns.get(id);
        return exp !== undefined && now < exp;
      };
      return findHuntableAnimal(
        bot,
        rallyPoint,
        maxRadius,
        targetAnimal,
        isCooldown,
        currentTargetId
      );
    },
  };
}

export function findAvailableFarmland(
  bot: PerceptionSource,
  rallyPoint: Position,
  maxRadius: number = 25,
  isCooldown?: (x: number, y: number, z: number) => boolean
): Position | null {
  const b = bot as any;
  if (typeof b.findBlock === 'function') {
    const point = new Vec3(rallyPoint.x, rallyPoint.y, rallyPoint.z).floored();
    const isFarmlandCandidateValid = (candidate: any): boolean => {
      if (!candidate || candidate.name !== 'farmland') return false;
      if (!candidate.position) return false;
      if (
        isCooldown &&
        isCooldown(candidate.position.x, candidate.position.y, candidate.position.z)
      ) {
        return false;
      }
      if (typeof b.blockAt === 'function') {
        const abovePos = candidate.position.offset
          ? candidate.position.offset(0, 1, 0)
          : new Vec3(candidate.position.x, candidate.position.y + 1, candidate.position.z);
        const above = b.blockAt(abovePos);
        if (!above || (above.name !== 'air' && above.name !== 'cave_air')) return false;
      }
      const dx = candidate.position.x - rallyPoint.x;
      const dz = candidate.position.z - rallyPoint.z;
      return Math.hypot(dx, dz) <= maxRadius;
    };

    const block = b.findBlock({
      matching: (candidate: any) => {
        if (!candidate || candidate.name !== 'farmland') return false;
        if (!candidate.position) return true; // Palette test in Mineflayer (candidate.position is null)
        return isFarmlandCandidateValid(candidate);
      },
      useExtraInfo: (candidate: any) => isFarmlandCandidateValid(candidate),
      maxDistance: 32,
      point,
    });
    if (block && block.position) {
      return position(block.position);
    }
  } else if (b.blocks) {
    for (const block of Object.values(b.blocks as Record<string, any>)) {
      if (!block || block.name !== 'farmland' || !block.position) continue;
      if (isCooldown && isCooldown(block.position.x, block.position.y, block.position.z)) continue;
      const dx = block.position.x - rallyPoint.x;
      const dz = block.position.z - rallyPoint.z;
      if (Math.hypot(dx, dz) > maxRadius) continue;
      if (block.above && block.above.name !== 'air' && block.above.name !== 'cave_air') continue;
      return position(block.position);
    }
  }
  return null;
}

export function findHuntableAnimal(
  bot: PerceptionSource,
  rallyPoint: Position,
  maxRadius: number = 25,
  targetAnimal?: string | null,
  isCooldown?: (entityId: number) => boolean,
  currentTargetId?: number | null
): { entityId: number; name: string; position: Position; distance: number } | null {
  const origin = bot.entity?.position;
  if (!origin) return null;

  const validTargets: readonly string[] = targetAnimal
    ? [targetAnimal.toLowerCase()]
    : (workConfig.huntTargetAnimals as readonly string[]);

  // Target retention: if currently hunting an animal that is still valid and in range, stick with it
  if (currentTargetId != null && bot.entities) {
    const retained = (bot.entities as any)[currentTargetId];
    if (
      retained &&
      retained.position &&
      retained.isValid !== false &&
      (retained as any).isDead !== true &&
      (retained.health === undefined || retained.health > 0) &&
      (!isCooldown || !isCooldown(currentTargetId))
    ) {
      const retainedName = (retained.name ?? '').toLowerCase();
      if (validTargets.includes(retainedName)) {
        const dx = retained.position.x - rallyPoint.x;
        const dz = retained.position.z - rallyPoint.z;
        if (Math.hypot(dx, dz) <= maxRadius) {
          const d = distance(origin, retained.position);
          return {
            entityId: currentTargetId,
            name: retainedName,
            position: position(retained.position),
            distance: d,
          };
        }
      }
    }
  }

  let best: { entityId: number; name: string; position: Position; distance: number } | null = null;
  let minDistance = Infinity;

  const entities = bot.entities ? Object.values(bot.entities) : [];
  for (const entity of entities) {
    if (!entity?.position) continue;
    if (entity.id === bot.entity?.id) continue;
    if ((entity as any).isValid === false || (entity as any).isDead === true) continue;
    const health = (entity as any).health;
    if (health !== undefined && health <= 0) continue;

    const name = (entity.name ?? '').toLowerCase();
    if (!validTargets.includes(name)) continue;

    if (isCooldown && isCooldown(entity.id)) continue;

    const dx = entity.position.x - rallyPoint.x;
    const dz = entity.position.z - rallyPoint.z;
    if (Math.hypot(dx, dz) > maxRadius) continue;

    const d = distance(origin, entity.position);
    if (d < minDistance) {
      minDistance = d;
      best = {
        entityId: entity.id,
        name,
        position: position(entity.position),
        distance: d,
      };
    }
  }

  return best;
}
