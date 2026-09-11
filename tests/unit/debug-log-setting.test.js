import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared in-memory fake of the SQLite adapter so the settings path can be
// exercised without touching the real DB file.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({ data: null }));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: async () => ({
    get: () => (mockState.data === null ? undefined : { data: mockState.data }),
    run: (_sql, params) => { mockState.data = params[0]; },
    transaction: (fn) => fn(),
  }),
}));

const MOD = "open-sse/utils/debugLog.js";
const SETTINGS_MOD = "@/lib/db/repos/settingsRepo.js";
const ORIGINAL_DEBUG_LOGS = process.env.DEBUG_LOGS;

describe("debugLog gating (module-level flag)", () => {
  let logSpy;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DEBUG_LOGS;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (ORIGINAL_DEBUG_LOGS === undefined) delete process.env.DEBUG_LOGS;
    else process.env.DEBUG_LOGS = ORIGINAL_DEBUG_LOGS;
  });

  it("is OFF by default — dbg() emits nothing", async () => {
    const { dbg, isDebugEnabled } = await import(MOD);
    expect(isDebugEnabled()).toBe(false);
    dbg("TEST", "should not appear");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("stays OFF when NODE_ENV is not production (no more dev-mode auto-enable)", async () => {
    // Regardless of the ambient NODE_ENV from the test runner, the default is off.
    const { isDebugEnabled } = await import(MOD);
    expect(isDebugEnabled()).toBe(false);
  });

  it("emits tagged lines after setDebugEnabled(true)", async () => {
    const { dbg, setDebugEnabled, isDebugEnabled } = await import(MOD);
    setDebugEnabled(true);
    expect(isDebugEnabled()).toBe(true);
    dbg("STREAM", "chunk #1");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0]).toContain("[DBG:STREAM]");
    expect(logSpy.mock.calls[0][0]).toContain("chunk #1");
  });

  it("goes silent again after setDebugEnabled(false)", async () => {
    const { dbg, setDebugEnabled } = await import(MOD);
    setDebugEnabled(true);
    dbg("TEST", "on");
    setDebugEnabled(false);
    dbg("TEST", "off");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("DEBUG_LOGS=1 forces output even when the setting (setter) is off", async () => {
    process.env.DEBUG_LOGS = "1";
    vi.resetModules();
    const { dbg, setDebugEnabled, isDebugEnabled } = await import(MOD);
    expect(isDebugEnabled()).toBe(true);
    setDebugEnabled(false);
    expect(isDebugEnabled()).toBe(true);
    dbg("TEST", "forced by env");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe("settings read/write refreshes the flag", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.DEBUG_LOGS;
    mockState.data = null;
  });

  afterEach(() => {
    if (ORIGINAL_DEBUG_LOGS === undefined) delete process.env.DEBUG_LOGS;
    else process.env.DEBUG_LOGS = ORIGINAL_DEBUG_LOGS;
    mockState.data = null;
  });

  it("defaults to OFF after getSettings() with no persisted value", async () => {
    const { getSettings } = await import(SETTINGS_MOD);
    const { isDebugEnabled } = await import(MOD);
    const settings = await getSettings();
    expect(settings.debugLogs).toBe(false);
    expect(isDebugEnabled()).toBe(false);
  });

  it("updateSettings({ debugLogs: true }) turns dbg() on immediately", async () => {
    const { updateSettings } = await import(SETTINGS_MOD);
    const { dbg, isDebugEnabled } = await import(MOD);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await updateSettings({ debugLogs: true });
      expect(isDebugEnabled()).toBe(true);
      dbg("TEST", "after update");
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("updateSettings({ debugLogs: false }) turns dbg() back off", async () => {
    const { getSettings, updateSettings } = await import(SETTINGS_MOD);
    const { isDebugEnabled } = await import(MOD);
    await updateSettings({ debugLogs: true });
    await updateSettings({ debugLogs: false });
    expect(isDebugEnabled()).toBe(false);
    // A later read of the persisted value must not re-enable it.
    const settings = await getSettings();
    expect(settings.debugLogs).toBe(false);
    expect(isDebugEnabled()).toBe(false);
  });
});
