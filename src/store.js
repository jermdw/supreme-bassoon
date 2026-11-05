import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class TokenStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'tokens.json');
    this.cache = null;
  }

  async load() {
    if (this.cache) return { ...this.cache };
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[store] Failed reading tokens.json, starting fresh:', err.message);
      }
      this.cache = {};
    }
    return { ...this.cache };
  }

  async save(patch) {
    const current = await this.load();
    const updated = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, this.filePath);
    this.cache = updated;
    return { ...updated };
  }

  async clear() {
    this.cache = {};
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

/** Returns the secret the clock sends with its button commands, creating it on first run. */
export async function loadOrCreateClockToken(dataDir) {
  const tokenPath = path.join(dataDir, 'clock-token');
  try {
    const existing = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = crypto.randomBytes(16).toString('hex');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tokenPath, token, { mode: 0o600 });
  return token;
}
