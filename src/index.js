import { loadConfig } from './config.js';
import { TokenStore, loadOrCreateClockToken } from './store.js';
import { SpotifyClient } from './spotify.js';
import { ArtworkProcessor, buildArtId } from './artwork.js';
import { AwtrixCoordinator } from './awtrix.js';
import { createBridgeServer } from './server.js';

const SPOTIFY_GREEN = 0x1db954;
// After this long without a good Spotify answer, stop claiming the last song is still playing.
const SPOTIFY_STALE_MS = 60_000;

async function main() {
  const config = loadConfig();
  const tokenStore = new TokenStore(config.dataDir);
  const clockToken = await loadOrCreateClockToken(config.dataDir);
  if (!config.awtrix.autoInstallScript) {
    console.log(`[awtrix-spotify] AUTO_INSTALL_SCRIPT is off: set the script's Bridge Token field to ${clockToken}`);
  }

  const spotify = new SpotifyClient({
    clientId: config.spotify.clientId,
    clientSecret: config.spotify.clientSecret,
    redirectUri: config.spotify.redirectUri,
    asciiTransliterate: config.display.asciiTransliterate,
    tokenStore,
  });

  const artwork = new ArtworkProcessor({
    gamma: config.display.ledGamma,
    saturation: config.display.ledSaturation,
  });

  const awtrix = new AwtrixCoordinator({
    host: config.awtrix.host,
    port: config.awtrix.port,
    username: config.awtrix.username,
    password: config.awtrix.password,
    appName: config.awtrix.appName,
    autoInstallScript: config.awtrix.autoInstallScript,
    switchOnTrackChange: config.awtrix.switchOnTrackChange,
    pauseGraceMs: config.polling.pauseGraceMs,
    serverLanUrl: config.serverLanUrl,
    pollActiveMs: config.polling.activeMs,
    clockToken,
  });

  let snapshot = {
    playing: false,
    id: '',
    title: 'Spotify',
    artist: 'Idle',
    album: '',
    progressMs: 0,
    durationMs: 1,
    accent: SPOTIFY_GREEN,
    art: null,
    artId: '',
    spotifyError: null,
    updatedAtMs: Date.now(),
  };

  let pollTimer = null;
  let pollInFlight = false;
  let stopped = false;
  let lastSpotifyOkMs = Date.now();

  function publishStopped(spotifyError = null) {
    snapshot = {
      ...snapshot,
      playing: false,
      spotifyError,
      updatedAtMs: Date.now(),
    };
    awtrix.requestPlaybackSync(snapshot);
  }

  async function pollOnce() {
    if (pollInFlight || stopped) return;
    pollInFlight = true;

    try {
      if (!(await spotify.isAuthorized())) {
        lastSpotifyOkMs = Date.now();
        if (snapshot.playing) publishStopped();
        return;
      }

      const track = await spotify.getCurrentlyPlaying();
      if (!track) {
        // Rate-limited (429); keep existing snapshot until backoff expires
        return;
      }
      lastSpotifyOkMs = Date.now();

      if (!track.id) {
        publishStopped();
        return;
      }

      let pixels = snapshot.id === track.id ? snapshot.art : null;
      let accent = snapshot.id === track.id ? snapshot.accent : SPOTIFY_GREEN;

      if (!pixels && track.imageUrl) {
        try {
          const artResult = await artwork.getArtwork(track.imageUrl);
          pixels = artResult.pixels;
          accent = artResult.accent;
        } catch (err) {
          console.warn(`[artwork] Failed processing cover art: ${err.message}`);
        }
      }

      snapshot = {
        playing: track.playing,
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        progressMs: track.progressMs,
        durationMs: track.durationMs,
        accent,
        art: pixels,
        artId: pixels && track.imageUrl ? buildArtId(track.imageUrl) : '',
        spotifyError: null,
        updatedAtMs: Date.now(),
      };

      awtrix.requestPlaybackSync(snapshot);
    } catch (err) {
      console.warn(`[poller] Poll error: ${err.message}`);
      if (snapshot.playing && Date.now() - lastSpotifyOkMs > SPOTIFY_STALE_MS) {
        publishStopped(err.message);
      } else {
        snapshot = { ...snapshot, spotifyError: err.message };
      }
    } finally {
      pollInFlight = false;
      scheduleNextPoll();
    }
  }

  function scheduleNextPoll() {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    const delay = snapshot.playing ? config.polling.activeMs : config.polling.idleMs;
    pollTimer = setTimeout(() => {
      pollOnce().catch(() => {});
    }, delay);
  }

  const server = createBridgeServer({
    config,
    clockToken,
    spotify,
    awtrix,
    getCurrentSnapshot: () => snapshot,
    triggerImmediatePoll: () => pollOnce(),
    onAuthorized: () => {
      pollOnce().catch(() => {});
    },
  });

  server.listen(config.port, '0.0.0.0', async () => {
    console.log(`[awtrix-spotify] Dashboard & API listening on http://127.0.0.1:${config.port}`);
    console.log(`[awtrix-spotify] TC002 LAN endpoint: ${config.serverLanUrl}/api/now-playing`);

    // Not awaited: an unreachable clock must not delay the first Spotify poll.
    awtrix.ensureScriptInstalled();
    await pollOnce();
    scheduleNextPoll();
  });

  async function shutdown(signal) {
    if (stopped) return;
    stopped = true;
    console.log(`[awtrix-spotify] Caught ${signal}, shutting down...`);
    if (pollTimer) clearTimeout(pollTimer);
    awtrix.dispose();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[awtrix-spotify] Fatal startup error:', err);
  process.exit(1);
});
