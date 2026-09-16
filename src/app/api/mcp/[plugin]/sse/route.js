import { registerSession, unregisterSession, findPlugin } from "@/lib/mcp/stdioSseBridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { plugin } = await params;
  if (!findPlugin(plugin)) {
    return new Response(`Unknown plugin: ${plugin}`, { status: 404 });
  }

  const encoder = new TextEncoder();
  const state = { closed: false, sid: null };
  const onAbort = () => cleanup();

  // Proxies can terminate an SSE request without Next.js invoking
  // ReadableStream.cancel(). Always unregister the MCP session on abort.
  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    if (state.sid) {
      unregisterSession(plugin, state.sid);
      state.sid = null;
    }
    request.signal.removeEventListener("abort", onAbort);
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) cleanup();

  const stream = new ReadableStream({
    start(controller) {
      if (state.closed) return;
      const send = (chunk) => controller.enqueue(encoder.encode(chunk));
      state.sid = registerSession(plugin, (chunk) => {
        if (state.closed) return;
        try { send(chunk); } catch { cleanup(); }
      });
      // The request may have been aborted while the session was registered.
      if (state.closed) {
        unregisterSession(plugin, state.sid);
        state.sid = null;
        return;
      }
      // MCP SSE handshake: tell client where to POST messages.
      try {
        send(`event: endpoint\ndata: /api/mcp/${plugin}/message?sessionId=${state.sid}\n\n`);
      } catch {
        cleanup();
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
