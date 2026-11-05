import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    pauseGraceMs = 6000,
    serverLanUrl,
    pollActiveMs = 2000,
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
    this.pauseGraceMs = pauseGraceMs;
    this.serverLanUrl = serverLanUrl;
    this.pollActiveMs = pollActiveMs;
    this.scriptPath = scriptPath;
    this.client = client;

    this.scriptSynced = false;
    this.useOrderRoute = false;
    this.appEnabled = null;
    this.lastActiveTrackId = '';
    this.pauseTimer = null;
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

      // Sync @config store only if server_url or poll_ms differs
      let needsConfigUpdate = true;
      try {
        const currentCfg = await client.scripts.getConfig(this.appName);
        const curUrl = currentCfg?.server_url?.value ?? currentCfg?.server_url;
        const curPoll = currentCfg?.poll_ms?.value ?? currentCfg?.poll_ms;
        if (curUrl === this.serverLanUrl && Number(curPoll) === this.pollActiveMs) {
          needsConfigUpdate = false;
        }
      } catch {
        // Proceed with updateConfig
      }

      if (needsConfigUpdate) {
        await client.scripts.updateConfig(this.appName, {
          server_url: this.serverLanUrl,
          poll_ms: this.pollActiveMs,
        });
        console.log(`[awtrix] Configured "${this.appName}" -> server_url=${this.serverLanUrl}`);
      }

      this.scriptSynced = true;
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
    } catch (err) {
      this.lastError = err.message;
      console.warn(`[awtrix] Failed syncing script to ${this.host}: ${err.message}`);
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
        console.warn(`[awtrix] Failed applying playback state: ${err.message}`);
      }
    }
  }

  async onPlaybackState(state) {
    if (!this.isConfigured() || !state) return;

    await this.ensureScriptInstalled();

    if (state.playing && state.id) {
      if (this.pauseTimer) {
        clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
      }

      const wasHidden = this.appEnabled !== true;
      const trackChanged = state.id !== this.lastActiveTrackId;
      this.lastActiveTrackId = state.id;

      try {
        const client = await this._getClient();
        if (wasHidden) {
          await this._setAppEnabled(client, true);
          this.appEnabled = true;
          console.log(`[awtrix] Enabled "${this.appName}" in rotation`);
        }

        if (wasHidden || (trackChanged && this.switchOnTrackChange)) {
          await client.apps.switchTo(this.appName);
          console.log(`[awtrix] Switched display to "${this.appName}" (${state.artist} - ${state.title})`);
        }
        this.lastError = null;
        this.lastSyncAt = new Date().toISOString();
      } catch (err) {
        this.lastError = err.message;
        this.appEnabled = null; // Force re-sync once clock is reachable again
        console.warn(`[awtrix] Failed updating clock state: ${err.message}`);
      }
      return;
    }

    // Paused or stopped: schedule auto-hide after grace period
    if (this.appEnabled !== false && !this.pauseTimer) {
      if (this.pauseGraceMs <= 0) {
        await this._disableApp();
      } else {
        this.pauseTimer = setTimeout(() => {
          this.pauseTimer = null;
          this._disableApp().catch(() => {});
        }, this.pauseGraceMs);
      }
    }
  }

  async _disableApp() {
    try {
      const client = await this._getClient();
      await this._setAppEnabled(client, false);
      this.appEnabled = false;
      this.lastActiveTrackId = '';
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      console.log(`[awtrix] Playback idle — hid "${this.appName}" from rotation`);
    } catch (err) {
      this.lastError = err.message;
      this.appEnabled = null;
      console.warn(`[awtrix] Failed hiding "${this.appName}": ${err.message}`);
    }
  }

  dispose() {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
  }
}
