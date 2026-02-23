import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export function loadEnvFile(path?: string): void {
  const envPath = path ?? resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    console.error('[clawdfather] Failed to load .env:', (err as Error).message);
  }
}
