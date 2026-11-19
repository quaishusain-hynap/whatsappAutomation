import 'dotenv/config';
import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { Server as SocketIOServer } from 'socket.io';
import { config } from './config.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import { setIo, type Io } from './realtime.js';
import { verifyAccessToken } from './modules/auth/tokens.js';
import { authRoutes } from './modules/auth/routes.js';
import { adminUserRoutes } from './modules/auth/admin-routes.js';
import { waRoutes } from './modules/wa/routes.js';
import { chatRoutes } from './modules/chats/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { sessionManager } from './modules/wa/session-manager.js';

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const app = Fastify({ loggerInstance: logger.child({ mod: 'http' }), bodyLimit: 1024 * 1024 });

  await app.register(cors, {
    origin: config.isProd ? false : ['http://localhost:5173'],
    credentials: true,
  });
  await app.register(cookie);
  await app.register(multipart);

  await app.register(authRoutes);
  await app.register(adminUserRoutes);
  await app.register(waRoutes);
  await app.register(chatRoutes);
  await app.register(mediaRoutes);

  app.get('/api/health', async () => ({ ok: true }));

  await app.ready();

  // socket.io shares Fastify's HTTP server
  const io: Io = new SocketIOServer(app.server, {
    cors: { origin: config.isProd ? false : ['http://localhost:5173'], credentials: true },
  });
  setIo(io);

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      const user = verifyAccessToken(token);
      (socket.data as { user: typeof user }).user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = (socket.data as { user: { sub: string; role: string } }).user;
    socket.join('staff');
    if (user.role === 'admin') socket.join('admin');
    logger.info({ userId: user.sub }, 'socket connected');

    socket.on('chat:focus', (chatId: string) => {
      void prisma.chat.update({ where: { id: chatId }, data: { unreadCount: 0 } }).catch(() => {});
    });
  });

  await sessionManager.init();

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(`server listening on http://localhost:${config.PORT}`);

  const shutdown = async () => {
    logger.info('shutting down');
    await sessionManager.stop().catch(() => {});
    await app.close().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error(err, 'fatal boot error');
  process.exit(1);
});
