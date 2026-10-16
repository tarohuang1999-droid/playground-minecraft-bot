import fs from 'node:fs';
import path from 'node:path';
import type { Position } from './blackboard.ts';
import { systemConfig } from './config/system.config.ts';

export interface PersistentState {
  base: Position | null;
  spawnPoint: Position | null;
}

export const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');
export const DEFAULT_STATE_FILE = path.resolve(process.cwd(), systemConfig.stateStorageFile);


export function loadPersistentState(filePath: string = DEFAULT_STATE_FILE): PersistentState {
  try {
    if (!fs.existsSync(filePath)) {
      return { base: null, spawnPoint: null };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      base: (parsed?.base && typeof parsed.base.x === 'number')
        ? { x: Number(parsed.base.x), y: Number(parsed.base.y), z: Number(parsed.base.z) }
        : null,
      spawnPoint: (parsed?.spawnPoint && typeof parsed.spawnPoint.x === 'number')
        ? { x: Number(parsed.spawnPoint.x), y: Number(parsed.spawnPoint.y), z: Number(parsed.spawnPoint.z) }
        : null,
    };
  } catch {
    return { base: null, spawnPoint: null };
  }
}

export function savePersistentState(
  state: PersistentState,
  filePath: string = DEFAULT_STATE_FILE
): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Ignore file write errors gracefully
  }
}
