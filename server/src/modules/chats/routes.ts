import type { FastifyInstance } from 'fastify';
import { sendMessageSchema } from '@mb/shared';
import { prisma } from '../../db.js';
import { requireAuth } from '../auth/guard.js';
import { sessionManager } from '../wa/session-manager.js';
import { messageInclude, toChatDTO, toMessageDTO } from './serialize.js';

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/chats', async (req) => {
    const { search } = req.query as { search?: string };
    const chats = await prisma.chat.findMany({
      where: {
        archived: false,
        ...(search
          ? {
              OR: [
                { contact: { pushName: { contains: search, mode: 'insensitive' } } },
                { contact: { phone: { contains: search } } },
                { contact: { customer: { name: { contains: search, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      take: 200,
      include: {
        contact: { include: { customer: { select: { name: true } } } },
        messages: { orderBy: { timestamp: 'desc' }, take: 1, include: messageInclude },
      },
    });
    return { chats: chats.map(toChatDTO) };
  });

  app.get('/api/chats/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { before, limit } = req.query as { before?: string; limit?: string };
    const take = Math.min(Number(limit) || 50, 200);

    const chat = await prisma.chat.findUnique({ where: { id }, include: { contact: true } });
    if (!chat) return reply.code(404).send({ error: 'chat not found' });

    const messages = await prisma.message.findMany({
      where: {
        chatId: id,
        ...(before ? { timestamp: { lt: new Date(before) } } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take,
      include: messageInclude,
    });

    // In groups, resolve sender JIDs to contact names for display
    let names = new Map<string, string>();
    if (chat.contact.isGroup) {
      const jids = [...new Set(messages.map((m) => m.senderJid).filter((j): j is string => !!j && j !== 'me'))];
      if (jids.length) {
        const contacts = await prisma.contact.findMany({
          where: { waAccountId: chat.waAccountId, jid: { in: jids } },
          select: { jid: true, pushName: true },
        });
        names = new Map(contacts.filter((c) => c.pushName).map((c) => [c.jid, c.pushName!]));
      }
    }

    // Chronological order for the client
    return {
      messages: messages.reverse().map((m) => toMessageDTO(m, m.senderJid ? names.get(m.senderJid) : null)),
      hasMore: messages.length === take,
    };
  });

  app.post('/api/chats/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = sendMessageSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'text or mediaId required' });
    if (!sessionManager.sendQueue) return reply.code(503).send({ error: 'whatsapp not initialised' });

    try {
      const dto = await sessionManager.sendQueue.enqueue({
        chatId: id,
        userId: req.user.sub,
        text: body.data.text,
        mediaId: body.data.mediaId,
        quotedMessageId: body.data.quotedMessageId,
      });
      return { message: dto };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/chats/:id/messages/:messageId/retry', async (req, reply) => {
    if (!sessionManager.sendQueue) return reply.code(503).send({ error: 'whatsapp not initialised' });
    const { messageId } = req.params as { messageId: string };
    try {
      await sessionManager.sendQueue.retry(messageId);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/chats/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    const chat = await prisma.chat.findUnique({ where: { id } });
    if (!chat) return reply.code(404).send({ error: 'chat not found' });

    await prisma.chat.update({ where: { id }, data: { unreadCount: 0 } });

    // Send read receipts for the latest inbound messages
    const recent = await prisma.message.findMany({
      where: { chatId: id, direction: 'inbound' },
      orderBy: { timestamp: 'desc' },
      take: 20,
      select: { waMessageId: true },
    });
    if (recent.length) {
      void sessionManager.markRead(chat.jid, recent.map((m) => m.waMessageId)).catch(() => {});
    }
    return { ok: true };
  });
}
