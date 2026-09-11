// Debug logging utility — gated by the `debugLogs` setting (default: OFF) and
// togglable at runtime from the dashboard console-log page.
// Outputs are tagged with [DBG:tag] for easy grep/filter.
//
// The flag lives in a module-level mutable variable (pure memory, no IO): dbg()
// sits on the streaming hot path and is called for every chunk, so it must never
// touch the DB. The settings repo refreshes it via setDebugEnabled() whenever
// settings are read (getSettings) or written (updateSettings).
//
// Env override: DEBUG_LOGS=1 forces debug logging on regardless of the setting
// (headless / no-UI deployments). Captured once at module load — same style as
// CURSOR_STREAM_DEBUG / LOG_USAGE_VERBOSE.
const ENV_FORCED = process.env.DEBUG_LOGS === "1";

let debugEnabled = false;

/** Refresh the runtime flag (called by the settings layer). */
export function setDebugEnabled(enabled) {
  debugEnabled = enabled === true;
}

/**
 * Whether debug logging is active right now. A function (not a bound value) so
 * callers can guard expensive argument construction lazily, e.g.
 * `isDebugEnabled() && dbg(tag, summarize(...))`.
 */
export function isDebugEnabled() {
  return ENV_FORCED || debugEnabled;
}

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dbg(tag, msg) {
  if (!isDebugEnabled()) return;
  console.log(`[${ts()}] 🐛 [DBG:${tag}] ${msg}`);
}
