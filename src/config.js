import path from 'node:path';
import os from 'node:os';

function parseBool(val, fallback) {
  if (val === undefined || val === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(val).trim().toLowerCase());
}

function parseIntSafe(val, fallback, min = 0) {
  const parsed = Number.parseInt(String(val ?? ''), 10);
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

function parseFloatSafe(val, fallback, min = 0.1) {
  const parsed = Number.parseFloat(String(val ?? ''));
  if (Number.isNaN(parsed) || parsed < min) return fallback;
  return parsed;
}

export function detectLanIp() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

export function loadConfig(env = process.env) {
  const port = parseIntSafe(env.PORT, 8765, 1);
  const detectedIp = detectLanIp();
  const rawServerUrl = (env.SERVER_LAN_URL || `http://${detectedIp}:${port}`).trim().replace(/\/+$/, '');

  return {
    port,
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.resolve(process.cwd(), 'data'),
    serverLanUrl: rawServerUrl,

    spotify: {
      clientId: (env.SPOTIFY_CLIENT_ID || '').trim(),
      clientSecret: (env.SPOTIFY_CLIENT_SECRET || '').trim(),
      redirectUri: (env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${port}/callback`).trim(),
    },

    awtrix: {
      host: (env.AWTRIX_HOST || '').trim(),
      port: parseIntSafe(env.AWTRIX_PORT, 80, 1),
      username: (env.AWTRIX_USERNAME || '').trim(),
      password: (env.AWTRIX_PASSWORD || '').trim(),
      appName: (env.AWTRIX_APP_NAME || 'spotify').trim(),
      autoInstallScript: parseBool(env.AUTO_INSTALL_SCRIPT, true),
      switchOnTrackChange: parseBool(env.SWITCH_ON_TRACK_CHANGE, true),
      keepOnScreen: parseBool(env.KEEP_ON_SCREEN, false),
    },

    polling: {
      activeMs: parseIntSafe(env.POLL_ACTIVE_MS, 2000, 1000),
      idleMs: parseIntSafe(env.POLL_IDLE_MS, 5000, 1000),
      deepIdleMs: parseIntSafe(env.POLL_DEEP_IDLE_MS, 30_000, 1000),
      deepIdleAfterMs: parseIntSafe(env.DEEP_IDLE_AFTER_MS, 600_000, 0),
      pausedScreenMs: parseIntSafe(env.PAUSED_SCREEN_MS, 300_000, 0),
    },

    display: {
      asciiTransliterate: parseBool(env.ASCII_TRANSLITERATE, true),
      ledGamma: parseFloatSafe(env.LED_GAMMA, 1.55, 0.5),
      ledSaturation: parseFloatSafe(env.LED_SATURATION, 1.25, 0.5),
    },
  };
}
