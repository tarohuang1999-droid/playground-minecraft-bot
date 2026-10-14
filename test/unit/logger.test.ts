import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../src/logger.ts';

test('logger: writes formatted logs to logs/bot-{id}-{date}.log', () => {
  const tmpDir = path.resolve(process.cwd(), 'logs', 'test-logger');
  const logger = createLogger('TestBot', tmpDir);

  logger.info('Test info message', { count: 42 });
  logger.warn('Test warning');
  logger.error('Test error');

  assert.ok(fs.existsSync(logger.logFilePath));
  const content = fs.readFileSync(logger.logFilePath, 'utf8');

  assert.match(content, /\[INFO\] Test info message {"count":42}/);
  assert.match(content, /\[WARN\] Test warning/);
  assert.match(content, /\[ERROR\] Test error/);

  // Clean up temporary test folder
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
