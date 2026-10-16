import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadPersistentState, savePersistentState } from '../../src/state-storage.ts';
import { createPerception } from '../../src/perception.ts';

test('state-storage: loads empty state if file does not exist', () => {
  const tmpPath = path.resolve(process.cwd(), 'data/test-nonexistent.json');
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const state = loadPersistentState(tmpPath);
  assert.deepStrictEqual(state, { base: null, spawnPoint: null });
});

test('state-storage: saves and reloads base and spawn point state', () => {
  const tmpPath = path.resolve(process.cwd(), 'data/test-state.json');
  try {
    savePersistentState({
      base: { x: 12.3, y: 64, z: -45.6 },
      spawnPoint: { x: 10, y: 64, z: 10 },
    }, tmpPath);

    assert.ok(fs.existsSync(tmpPath));

    const loaded = loadPersistentState(tmpPath);
    assert.deepStrictEqual(loaded, {
      base: { x: 12.3, y: 64, z: -45.6 },
      spawnPoint: { x: 10, y: 64, z: 10 },
    });
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

test('state-storage: createPerception automatically loads and persists state', () => {
  const tmpPath = path.resolve(process.cwd(), 'data/test-perception.json');
  try {
    const fakeBot: any = {
      health: 20,
      food: 20,
      players: {},
      entities: {},
      entity: { position: { x: 0, y: 64, z: 0 } },
    };

    // 1. Initial perception with empty state
    const p1 = createPerception(fakeBot, 'owner', { storagePath: tmpPath });
    assert.strictEqual(p1.getBase(), null);
    assert.strictEqual(p1.getSpawnPoint(), null);

    // 2. Set base and spawn point
    p1.setBase({ x: 35.4, y: -59.0, z: 18.3 });
    p1.setSpawnPoint({ x: 31.0, y: -59.0, z: 18.0 });

    // 3. New perception instance pointing to same file should restore base and spawnPoint
    const p2 = createPerception(fakeBot, 'owner', { storagePath: tmpPath });
    assert.deepStrictEqual(p2.getBase(), { x: 35.4, y: -59.0, z: 18.3 });
    assert.deepStrictEqual(p2.getSpawnPoint(), { x: 31.0, y: -59.0, z: 18.0 });
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});
