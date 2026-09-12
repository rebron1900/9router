import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fsPromises from "fs/promises";
import fs from "fs";
import os from "os";
import path from "path";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os.homedir so candidate paths are deterministic; keep the real tmpdir().
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = vi.fn(() => "/mock/home");
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// Mock fs/promises.access — the route uses it to probe candidate db paths.
vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Mock child_process — used for the `which cursor` install check and the
// sqlite3 CLI fallback. Reject by default so no real process is spawned.
vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import { promisify } from "util";

// Node's real execFile resolves `{ stdout, stderr }` under promisify via a
// custom symbol; the default promisify would only surface `stdout`. Mirror that
// on the mock so the route's `const { stdout } = await execFileAsync(...)` works.
execFile[promisify.custom] = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });

// ── Real SQLite fixture ───────────────────────────────────────────────
// The route loads the db through a bare `require("better-sqlite3")`, which
// vitest's vi.mock() cannot intercept. Build a genuine state.vscdb fixture
// instead and let the route open it for real.
const Database = (await import("better-sqlite3")).default;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cursor-ai-"));
const DB_DIR = path.join(TMP_ROOT, "Cursor", "User", "globalStorage");
const DB_PATH = path.join(DB_DIR, "state.vscdb");
fs.mkdirSync(DB_DIR, { recursive: true });

function writeCursorDb(rows) {
  fs.rmSync(DB_PATH, { force: true });
  const db = new Database(DB_PATH);
  try {
    db.exec("CREATE TABLE itemTable (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO itemTable (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  } finally {
    db.close();
  }
}

function removeCursorDb() {
  fs.rmSync(DB_PATH, { force: true });
}

// ── Candidate path helpers (mirror the route) ─────────────────────────
const home = () => os.homedir();
const darwinCandidate = (suffix = "Cursor") =>
  path.join(home(), `Library/Application Support/${suffix}/User/globalStorage/state.vscdb`);
const linuxCandidate = (suffix = "Cursor") =>
  path.join(home(), `.config/${suffix}/User/globalStorage/state.vscdb`);
const linuxDesktopFile = () =>
  path.join(home(), ".local/share/applications/cursor.desktop");
// win32 candidate #1 — APPDATA is pointed at TMP_ROOT so it resolves to DB_PATH.
const win32Candidate = () =>
  path.join(process.env.APPDATA, "Cursor", "User", "globalStorage", "state.vscdb");

const setPlatform = (value) =>
  Object.defineProperty(process, "platform", { value, writable: true, configurable: true });

let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.APPDATA = TMP_ROOT;
    // Default: no sqlite3 CLI and no `which` on PATH.
    vi.mocked(execFile).mockImplementation((_file, _args, _opts, cb) => {
      const done = typeof _opts === "function" ? _opts : cb;
      done(new Error("spawn ENOENT"));
    });
    // Re-import to pick up fresh mocks each run
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  });

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  // ── macOS path probing ────────────────────────────────────────────────

  it("lists the probed macOS locations when no Cursor database is accessible", async () => {
    setPlatform("darwin");
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    expect(response.body.error).toContain("Make sure Cursor IDE is installed and opened at least once.");
    // The macOS candidates (standard + Insiders) are the ones probed.
    expect(response.body.error).toContain(darwinCandidate());
    expect(response.body.error).toContain(darwinCandidate("Cursor - Insiders"));
    expect(fsPromises.access).toHaveBeenCalledWith(darwinCandidate(), 4);
  });

  // ── Token extraction (real Cursor database) ───────────────────────────

  it("extracts tokens using exact keys", async () => {
    setPlatform("win32");
    writeCursorDb({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    removeCursorDb();
  });

  it("unwraps JSON-encoded string values", async () => {
    setPlatform("win32");
    writeCursorDb({
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
    removeCursorDb();
  });

  it("falls back to alternate key names when the preferred keys are missing", async () => {
    setPlatform("win32");
    writeCursorDb({
      "cursorAuth/token": "alt-token",
      "storage.machineId": "alt-machine-id",
    });
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("alt-token");
    expect(response.body.machineId).toBe("alt-machine-id");
    removeCursorDb();
  });

  // ── sqlite3 CLI fallback ──────────────────────────────────────────────

  it("falls back to the sqlite3 CLI when the native driver cannot open the database", async () => {
    setPlatform("win32");
    removeCursorDb(); // fs.access is mocked, so the route still picks this path
    vi.mocked(fsPromises.access).mockResolvedValue();
    vi.mocked(execFile).mockImplementation((file, args, _opts, cb) => {
      const done = typeof _opts === "function" ? _opts : cb;
      if (file !== "sqlite3") return done(new Error("spawn ENOENT"));
      const sql = String(args?.[1] || "");
      if (sql.includes("cursorAuth/accessToken")) return done(null, '"cli-token"\n', "");
      if (sql.includes("storage.serviceMachineId")) return done(null, '"cli-machine-id"\n', "");
      return done(new Error("no rows"));
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("cli-token");
    expect(response.body.machineId).toBe("cli-machine-id");
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "sqlite3",
      [win32Candidate(), expect.stringContaining("cursorAuth/accessToken")],
      expect.objectContaining({ timeout: 10000 }),
      expect.any(Function),
    );
  });

  it("asks for manual entry when neither the database nor the CLI yields tokens", async () => {
    setPlatform("win32");
    removeCursorDb();
    vi.mocked(fsPromises.access).mockResolvedValue();

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toBe(win32Candidate());
  });

  // ── linux / unknown platform ─────────────────────────────────────────

  it("linux reports not-found when the ~/.config database is absent", async () => {
    setPlatform("linux");
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    expect(response.body.error).toContain(linuxCandidate());
    expect(fsPromises.access).toHaveBeenCalledWith(linuxCandidate(), 4);
  });

  it("linux reports not-installed when Cursor has no config but no executable", async () => {
    setPlatform("linux");
    // Candidate db readable; the Cursor desktop launcher is not present.
    vi.mocked(fsPromises.access).mockImplementation(async (candidate) => {
      if (candidate === linuxDesktopFile()) throw new Error("ENOENT");
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("does not appear to be installed");
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "which",
      ["cursor"],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it("unknown platform falls back to the ~/.config candidate paths", async () => {
    setPlatform("freebsd");
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(linuxCandidate());
    expect(response.body.error).toContain(linuxCandidate("cursor"));
  });
});
