/**
 * Logs a repeating warning once, then at most once per interval with a count, so an outage
 * doesn't fill the log. A changed message under the same key is logged straight away.
 */
export class RepeatLimiter {
  constructor({ log = console.warn, intervalMs = 3_600_000, now = Date.now } = {}) {
    this.log = log;
    this.intervalMs = intervalMs;
    this.now = now;
    this.entries = new Map();
  }

  warn(key, message) {
    const entry = this.entries.get(key);
    const nowMs = this.now();
    if (!entry || entry.message !== message) {
      this.entries.set(key, { message, suppressed: 0, total: 1, loggedAtMs: nowMs });
      this.log(message);
      return;
    }
    entry.total++;
    if (nowMs - entry.loggedAtMs >= this.intervalMs) {
      this.log(`${message} (repeated ${entry.suppressed + 1} more times)`);
      entry.suppressed = 0;
      entry.loggedAtMs = nowMs;
    } else {
      entry.suppressed++;
    }
  }

  recovered(key, message) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.log(`${message} (after ${entry.total} failed attempts)`);
  }
}
