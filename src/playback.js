/** Whether the clock should take a turn for this state: playing, or recently paused. */
export function isClockVisible(snapshot, nowMs, pausedScreenMs) {
  if (snapshot.playing) return true;
  return Boolean(snapshot.pausedAtMs) && nowMs - snapshot.pausedAtMs < pausedScreenMs;
}

/** Polls Spotify less often once nothing has played for a while. */
export function nextPollDelay({ playing, lastPlayingMs, nowMs, polling }) {
  if (playing) return polling.activeMs;
  return nowMs - lastPlayingMs >= polling.deepIdleAfterMs ? polling.deepIdleMs : polling.idleMs;
}
