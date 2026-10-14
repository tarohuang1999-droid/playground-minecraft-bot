import fs from 'node:fs';
import path from 'node:path';

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  logFilePath: string;
}

export function createLogger(botId: string, baseDir: string = process.cwd()): Logger {
  const dateStr = new Date().toISOString().slice(0, 10);
  const logsDir = path.resolve(baseDir, 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const logFilePath = path.join(logsDir, `bot-${botId}-${dateStr}.log`);

  function log(level: string, message: string, data?: unknown) {
    const time = new Date().toISOString();
    const extra = data !== undefined ? (typeof data === 'object' ? ` ${JSON.stringify(data)}` : ` ${data}`) : '';
    const line = `[${time}] [${level}] ${message}${extra}\n`;
    try {
      fs.appendFileSync(logFilePath, line, 'utf8');
    } catch {
      // Avoid crashing if file write fails
    }
    if (level === 'ERROR') {
      console.error(`[${level}] ${message}${extra}`);
    } else {
      console.log(`[${level}] ${message}${extra}`);
    }
  }

  return {
    info: (msg, data) => log('INFO', msg, data),
    warn: (msg, data) => log('WARN', msg, data),
    error: (msg, data) => log('ERROR', msg, data),
    debug: (msg, data) => log('DEBUG', msg, data),
    logFilePath,
  };
}
