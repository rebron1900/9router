import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// cursorModels.js speaks to the HTTP/2-only agent.api5.cursor.sh host through
// node:http2 (Node's fetch/undici cannot negotiate h2 against that endpoint).
// Mock the http2 transport — this module never calls global.fetch.
const h2 = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("http2", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...(actual.default || {}), connect: h2.connect },
  };
});

import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

const CURSOR_MODELS_URL = "https://agent.api5.cursor.sh";

/** Stand in for an h2 session: one client → one request → one response. */
function fakeHttp2Exchange({ status = 200, body = Buffer.alloc(0) } = {}) {
  const req = new EventEmitter();
  req.write = vi.fn();
  req.destroy = vi.fn();
  req.end = vi.fn(() => {
    queueMicrotask(() => {
      req.emit("response", { ":status": status });
      if (body?.length) req.emit("data", Buffer.from(body));
      req.emit("end");
    });
  });

  const client = new EventEmitter();
  client.request = vi.fn(() => req);
  client.close = vi.fn();
  h2.connect.mockReturnValue(client);

  return { client, req };
}

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const { client } = fakeHttp2Exchange({ status: 200, body: payload });
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    // Second resolve is served from cache: exactly one round trip.
    expect(h2.connect).toHaveBeenCalledTimes(1);
    expect(h2.connect).toHaveBeenCalledWith(CURSOR_MODELS_URL);
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ":method": "POST",
        ":path": "/agent.v1.AgentService/GetUsableModels",
        "content-type": "application/proto",
        accept: "application/proto",
      }),
    );
  });

  it("fails open when the Cursor catalog request fails", async () => {
    fakeHttp2Exchange({ status: 403, body: Buffer.from("no") });

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
