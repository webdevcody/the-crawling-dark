import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_SERVER_PORT, TICK_RATE } from '@crawling-dark/shared';
import { Room } from './game/Room';

/**
 * Authoritative WebSocket server for The Crawling Dark (M1 · Networking Spine).
 *
 * The socket lifecycle is thin: every connection is handed to the single
 * {@link Room}, which owns the player registry, the fixed-timestep simulation
 * loop, and snapshot broadcasting. This file only bridges `ws` events to the
 * room and keeps the lifecycle logging.
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

/** The single game room: registry + simulation + snapshot broadcast. */
const room = new Room();
room.start();

const wss = new WebSocketServer({ port });

wss.on('listening', () => {
  console.log(`[server] listening on :${port} @ ${TICK_RATE}Hz tick`);
});

wss.on('connection', (socket: WebSocket) => {
  const player = room.join(socket);
  const role = player.spectator ? ' as spectator' : '';
  console.log(`[server] client #${player.id} connected${role} (${room.size} online)`);

  socket.on('message', (data) => {
    room.handleMessage(player, data);
  });

  socket.on('error', (err: Error) => {
    console.error(`[server] client #${player.id} error: ${err.message}`);
    room.remove(player);
  });

  socket.on('close', () => {
    room.remove(player);
    console.log(`[server] client #${player.id} disconnected (${room.size} online)`);
  });
});

wss.on('error', (err: Error) => {
  console.error(`[server] server error: ${err.message}`);
});
