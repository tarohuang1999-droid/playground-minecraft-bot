export const systemConfig = {
  tickIntervalMs: 100, // 10Hz Decision Loop
  fenceTickMs: 50, // 1 Tick Fence
  chatIntervalMs: 1000,
  chatQueueLimit: 5,
  observationRadius: 32,
  stateStorageFile: 'data/state.json',
  storagePath: 'data/state.json',
} as const;
