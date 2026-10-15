import { createWorld, type Position, type WorldState } from './blackboard.ts';
import { THRESHOLDS } from './policy.ts';

interface VisibleEntity {
  id: number;
  position: Position;
  name?: string;
  username?: string;
  displayName?: string;
  getDroppedItem?: () => { name: string } | null;
}
export interface PerceptionSource {
  entity: VisibleEntity;
  health: number;
  food: number;
  entities: Record<string, VisibleEntity>;
  players: Record<string, { entity?: VisibleEntity; username?: string }>;
  inventory: { emptySlotCount(): number };
}
const position = (value: Position): Position => ({ x: value.x, y: value.y, z: value.z });
const distance = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function createPerception(bot: PerceptionSource, owner: string) {
  return {
    sample(cooldowns?: Record<number, number>): WorldState {
      const world = createWorld(owner);
      const origin = bot.entity.position;
      world.self = { position: position(origin), health: bot.health, food: bot.food, isAlive: bot.health > 0, tookDamageRecently: false };
      let master = bot.players[owner]?.entity;
      const matchKey = Object.keys(bot.players).find(k => k.toLowerCase() === owner.toLowerCase());
      if (!master && matchKey) master = bot.players[matchKey]?.entity;
      if (!master && (bot.players[owner] || matchKey) && bot.entities) {
        const matchEntity = Object.values(bot.entities).find(e => (e.username ?? e.name ?? '').toLowerCase() === owner.toLowerCase());
        if (matchEntity) master = matchEntity;
      }
      if (master) world.master = { username: owner, entityId: master.id, position: position(master.position), distance: distance(origin, master.position) };
      const now = Date.now();
      for (const entity of Object.values(bot.entities)) {
        if (!entity?.position) continue;
        if (entity.id === bot.entity.id) continue;
        const range = distance(origin, entity.position);
        if (range > THRESHOLDS.observationRadius) continue;
        world.entities.push({ entityId: entity.id, name: entity.name ?? entity.username ?? 'unknown', position: position(entity.position), distance: range });

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
      world.nearbyDrops.sort((a, b) => a.distance - b.distance || a.entityId - b.entityId);
      world.inventory.freeSlots = bot.inventory.emptySlotCount();
      return world;
    },
  };
}
