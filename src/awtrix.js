import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepeatLimiter } from './logging.js';
import { isClockVisible } from './playback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPT_PATH = path.resolve(__dirname, '../berry/spotify_now_playing.be');

// Firmware before 1.2.2 has no /apps/{name}/enabled route. It reads "spotify/enabled" as
// the app name and rejects the slash with 400 invalidName.
function isEnabledRouteMissing(err) {
  return err?.status === 404 || (err?.status === 400 && err?.code === 'invalidName');
}

export class AwtrixCoordinator {
  constructor({
    host,
    port = 80,
    username = '',
    password = '',
    appName = 'spotify',
    autoInstallScript = true,
    switchOnTrackChange = true,
    pausedScreenMs = 300_000,
    keepOnScreen = false,
    serverLanUrl,
    pollActiveMs = 2000,
    clockToken = '',
    scriptPath = DEFAULT_SCRIPT_PATH,
    client = null,
  }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.appName = appName;
    this.autoInstallScript = autoInstallScript;
    this.switchOnTrackChange = switchOnTrackChange;
    this.pausedScreenMs = pausedScreenMs;
    this.keepOnScreen = keepOnScreen;
    this.serverLanUrl = serverLanUrl;
    this.pollActiveMs = pollActiveMs;
    this.clockToken = clockToken;
    this.scriptPath = scriptPath;
    this.client = client;

    this.scriptSynced = false;
    this.useOrderRoute = false;
    this.appEnabled = null;
    this.lastActiveTrackId = '';
    this.showing = false;
    this.warnings = new RepeatLimiter();
    this.lastError = null;
    this.lastSyncAt = null;
    this.scriptSyncPromise = null;
    this.pendingState = null;
    this.playbackSyncPromise = null;
  }

  isConfigured() {
    return Boolean(this.host);
  }

  async _getClient() {
    if (this.client) return this.client;
    const mod = await import('awtrix-ng-api');
    const AwtrixClient = mod.AwtrixClient || mod.default?.AwtrixClient;
    const opts = {
      host: this.host,
      port: this.port,
      protocol: 'http',
      timeout: 5000,
    };
    if (this.username || this.password) {
      opts.auth = { username: this.username, password: this.password };
    }
    this.client = new AwtrixClient(opts);
    return this.client;
  }

  async _setAppEnabled(client, enabled) {
    if (!this.useOrderRoute) {
      try {
        await client.apps.setEnabled(this.appName, enabled);
        return;
      } catch (err) {
        if (!isEnabledRouteMissing(err)) throw err;
        this.useOrderRoute = true;
        console.log('[awtrix] Firmware has no per-app enable route (added in 1.2.2); using the app order route');
      }
    }

    const apps = await client.apps.list();
    const others = apps.filter((app) => app.name !== this.appName);
    const order = others
      .filter((app) => app.enabled)
      .sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity))
      .map((app) => app.name);
    const disabled = others.filter((app) => !app.enabled).map((app) => app.name);
    (enabled ? order : disabled).push(this.appName);
    await client.apps.setOrder({ order, disabled });
  }

  /** Switches the app on if it's off. A no-op otherwise, since the order route rewrites the rotation. */
  async _ensureEnabled(client) {
    const apps = await client.apps.list();
    const app = apps.find((entry) => entry.name === this.appName);
    if (app && !app.enabled) {
      await this._setAppEnabled(client, true);
      console.log(`[awtrix] Enabled "${this.appName}" in rotation`);
    }
    this.appEnabled = true;
  }

  async ensureScriptInstalled() {
    if (!this.isConfigured() || !this.autoInstallScript || this.scriptSynced) {
      return;
    }
    if (!this.scriptSyncPromise) {
      this.scriptSyncPromise = this._syncScript().finally(() => {
        this.scriptSyncPromise = null;
      });
    }
    return this.scriptSyncPromise;
  }

  async _syncScript() {
    try {
      const client = await this._getClient();
      const desiredSource = await fs.readFile(this.scriptPath, 'utf8');

      // A script installed while its app is off never starts its timers once switched on, even
      // though it draws and reports as enabled (seen on 1.1.2). So this has to come first.
      await this._ensureEnabled(client);

      let existingSource = null;
      try {
        const res = await client.scripts.getSource(this.appName);
        existingSource = typeof res === 'string' ? res : res?.source ?? null;
      } catch {
        // Script not installed yet
      }

      if (existingSource !== desiredSource) {
        const installRes = await client.scripts.install(this.appName, desiredSource);
        if (installRes?.error) {
          throw new Error(
            `Berry compile error (line ${installRes.error.line}): ${installRes.error.message}`
          );
        }
        console.log(`[awtrix] Installed Berry script "${this.appName}" on ${this.host}`);
      }

      // Saving the config restarts the script, so only do it when a value differs.
      const desiredConfig = {
        server_url: this.serverLanUrl,
        poll_ms: this.pollActiveMs,
        token: this.clockToken,
        keep_on_screen: this.keepOnScreen,
      };
      let needsConfigUpdate = true;
      try {
        const { fields = [] } = await client.scripts.getConfig(this.appName);
        const current = Object.fromEntries(fields.map((field) => [field.key, field.value]));
        needsConfigUpdate = Object.entries(desiredConfig).some(([key, value]) => current[key] !== value);
      } catch {
        // Proceed with updateConfig
      }

      if (needsConfigUpdate) {
        await client.scripts.updateConfig(this.appName, desiredConfig);
        console.log(`[awtrix] Configured "${this.appName}" -> server_url=${this.serverLanUrl}`);
      }

      this.scriptSynced = true;
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      this.warnings.recovered('sync', '[awtrix] Script synced');
    } catch (err) {
      this.lastError = err.message;
      this.warnings.warn('sync', `[awtrix] Failed syncing script to ${this.host}: ${err.message}`);
    }
  }

  /**
   * Applies the newest state in the background so a slow or unreachable clock never delays
   * Spotify polling. States that arrive while one is being applied replace each other.
   */
  requestPlaybackSync(state) {
    this.pendingState = state;
    if (!this.playbackSyncPromise) {
      this.playbackSyncPromise = this._drainPlaybackSync().finally(() => {
        this.playbackSyncPromise = null;
      });
    }
    return this.playbackSyncPromise;
  }

  async _drainPlaybackSync() {
    while (this.pendingState) {
      const state = this.pendingState;
      this.pendingState = null;
      try {
        await this.onPlaybackState(state);
      } catch (err) {
        this.lastError = err.message;
        this.warnings.warn('apply', `[awtrix] Failed applying playback state: ${err.message}`);
      }
    }
  }

  async onPlaybackState(state) {
    if (!this.isConfigured() || !state) return;

    await this.ensureScriptInstalled();

    const playing = Boolean(state.playing && state.id);
    const visible = playing || isClockVisible(state, Date.now(), this.pausedScreenMs);

    try {
      const client = await this._getClient();
      // A switched-off script can't poll, so the app stays on and the script's should_show()
      // decides whether it takes a turn in the rotation.
      if (this.appEnabled !== true) {
        await this._ensureEnabled(client);
      }

      if (playing) {
        const trackChanged = state.id !== this.lastActiveTrackId;
        if (!this.showing || (trackChanged && this.switchOnTrackChange)) {
          await client.apps.switchTo(this.appName);
          console.log(`[awtrix] Switched display to "${this.appName}" (${state.artist} - ${state.title})`);
        }
        this.lastActiveTrackId = state.id;
      }
      if (!visible) this.lastActiveTrackId = '';
      this.showing = visible;

      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      this.warnings.recovered('state', '[awtrix] Clock reachable again');
    } catch (err) {
      this.lastError = err.message;
      this.appEnabled = null; // Force re-sync once clock is reachable again
      this.warnings.warn('state', `[awtrix] Failed updating clock state: ${err.message}`);
    }
  }

}
