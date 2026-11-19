import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@mb/shared';

export type Io = Server<ClientToServerEvents, ServerToClientEvents>;

let io: Io | null = null;

export function setIo(server: Io) {
  io = server;
}

/** Emit to all authenticated staff. Safe no-op before socket server boots. */
export function emitStaff<E extends keyof ServerToClientEvents>(
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  io?.to('staff').emit(event, ...args);
}

/** Emit to admins only (QR codes, connection control). */
export function emitAdmin<E extends keyof ServerToClientEvents>(
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) {
  io?.to('admin').emit(event, ...args);
}
