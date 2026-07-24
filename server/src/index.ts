import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_SERVER_PORT, TICK_RATE } from '@crawling-dark/shared';

/**
 * Minimal authoritative WebSocket server for The Crawling Dark.
 *
 * For now it only accepts connections and logs lifecycle events with a
 * stable per-socket id. Simulation, snapshots and input handling land in
 * later tasks; this is the foundation they attach to.
 */

/** Resolve the listen port from the environment, falling back to the shared default. */
function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_SERVER_PORT;
}

const port = resolvePort();

/** Monotonically increasing id handed to each new socket. Never reused. */
let nextId = 1;
/** Number of sockets currently connected. */
let connected = 0;

const wss = new WebSocketServer({ port });

wss.on('listening', () => {
  console.log(`[server] listening on :${port} @ ${TICK_RATE}Hz tick`);
});

wss.on('connection', (socket: WebSocket) => {
  const id = nextId++;
  connected++;
  console.log(`[server] client #${id} connected (${connected} online)`);

  socket.on('message', (data) => {
    // No protocol yet; log at a low volume so we can see traffic during dev.
    console.log(`[server] client #${id} message (${data.toString().length} bytes)`);
  });

  socket.on('error', (err: Error) => {
    console.error(`[server] client #${id} error: ${err.message}`);
  });

  socket.on('close', () => {
    connected--;
    console.log(`[server] client #${id} disconnected (${connected} online)`);
  });
});

wss.on('error', (err: Error) => {
  console.error(`[server] server error: ${err.message}`);
});
