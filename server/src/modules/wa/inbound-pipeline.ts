import { logger } from '../../logger.js';
import { prisma } from '../../db.js';
import { emitStaff } from '../../realtime.js';
import { saveMediaBuffer } from '../media/storage.js';
import { messageInclude, toChatDTO, toMessageDTO } from '../chats/serialize.js';
import type { NormalizedMessage, NormalizedStatusUpdate, WhatsAppProvider } from './provider.js';

const STATUS_RANK: Record<string, number> = {
  pending: 0, failed: 0, sent: 1, delivered: 2, read: 3, played: 4,
};

export class InboundPipeline {
  constructor(
    private readonly waAccountId: string,
    private readonly provider: WhatsAppProvider,
  ) {}

  /** Upsert contact + chat rows for a jid, returning the chat with relations. */
  private async ensureChat(chatJid: string, pushName?: string | null) {
    const isGroup = chatJid.endsWith('@g.us');
    let contact = await prisma.contact.upsert({
      where: { waAccountId_jid: { waAccountId: this.waAccountId, jid: chatJid } },
      update: {},
      create: {
        waAccountId: this.waAccountId,
        jid: chatJid,
        pushName: isGroup ? null : pushName ?? null,
        phone: isGroup ? null : chatJid.split('@')[0]!.split(':')[0]!,
        isGroup,
      },
    });
    // A push name is better than nothing, but never overwrite a saved name
    if (!isGroup && pushName && !contact.pushName) {
      contact = await prisma.contact.update({ where: { id: contact.id }, data: { pushName } });
    }
    const chat = await prisma.chat.upsert({
      where: { waAccountId_jid: { waAccountId: this.waAccountId, jid: chatJid } },
      update: {},
      create: { waAccountId: this.waAccountId, contactId: contact.id, jid: chatJid },
    });
    return { chat, contact };
  }

  /**
   * Persist one normalized message. `live` distinguishes real-time messages
   * (unread bump + socket emit + media download) from history backfill.
   */
  async handleMessage(msg: NormalizedMessage, opts: { live: boolean }) {
    try {
      const { chat } = await this.ensureChat(msg.chatJid, msg.fromMe ? null : msg.pushName);

      // Remember group participants' names as they message
      if (msg.chatJid.endsWith('@g.us') && !msg.fromMe && msg.pushName && !msg.senderJid.endsWith('@lid')) {
        await prisma.contact.upsert({
          where: { waAccountId_jid: { waAccountId: this.waAccountId, jid: msg.senderJid } },
          update: {},
          create: {
            waAccountId: this.waAccountId,
            jid: msg.senderJid,
            pushName: msg.pushName,
            phone: msg.senderJid.split('@')[0]!.split(':')[0]!,
            isGroup: false,
          },
        }).catch(() => {});
      }

      const quoted = msg.quotedWaMessageId
        ? await prisma.message.findUnique({
            where: { chatId_waMessageId: { chatId: chat.id, waMessageId: msg.quotedWaMessageId } },
            select: { id: true },
          })
        : null;

      const existing = await prisma.message.findUnique({
        where: { chatId_waMessageId: { chatId: chat.id, waMessageId: msg.waMessageId } },
      });

      let rowId: string;
      let isNew = false;
      if (existing) {
        // Echo of a message we sent ourselves (pre-generated id) or a
        // reconnect re-emit. Never touch sentByUserId; only lift status.
        rowId = existing.id;
        await prisma.message.update({
          where: { id: existing.id },
          data: {
            raw: msg.raw as object,
            ...(existing.status === 'pending' && msg.fromMe ? { status: 'sent' } : {}),
          },
        });
      } else {
        isNew = true;
        const row = await prisma.message.create({
          data: {
            chatId: chat.id,
            waMessageId: msg.waMessageId,
            direction: msg.fromMe ? 'outbound' : 'inbound',
            senderJid: msg.senderJid,
            type: msg.type,
            body: msg.body,
            quotedMessageId: quoted?.id ?? null,
            status: msg.fromMe ? 'sent' : 'delivered',
            timestamp: msg.timestamp,
            raw: msg.raw as object,
          },
        });
        rowId = row.id;
      }

      // Chat bookkeeping
      const bumpUnread = opts.live && isNew && !msg.fromMe;
      await prisma.chat.update({
        where: { id: chat.id },
        data: {
          ...(chat.lastMessageAt == null || chat.lastMessageAt < msg.timestamp
            ? { lastMessageAt: msg.timestamp }
            : {}),
          ...(bumpUnread ? { unreadCount: { increment: 1 } } : {}),
        },
      });

      if (opts.live) {
        const [full, chatFull] = await Promise.all([
          prisma.message.findUnique({ where: { id: rowId }, include: messageInclude }),
          prisma.chat.findUnique({
            where: { id: chat.id },
            include: {
              contact: { include: { customer: { select: { name: true } } } },
              messages: { orderBy: { timestamp: 'desc' }, take: 1, include: messageInclude },
            },
          }),
        ]);
        if (full && isNew) {
          // In groups, resolve the sender's name for the bubble header
          let senderName: string | null = null;
          if (msg.chatJid.endsWith('@g.us') && !msg.fromMe) {
            senderName = msg.pushName ?? null;
            const senderContact = await prisma.contact.findUnique({
              where: { waAccountId_jid: { waAccountId: this.waAccountId, jid: msg.senderJid } },
              select: { pushName: true },
            });
            if (senderContact?.pushName) senderName = senderContact.pushName;
          }
          emitStaff('message:new', toMessageDTO(full, senderName));
        }
        if (chatFull) emitStaff('chat:updated', toChatDTO(chatFull));

        if (isNew && msg.hasMedia) void this.downloadMediaFor(rowId, msg);
      }
    } catch (err) {
      logger.error({ err, waMessageId: msg.waMessageId }, 'inbound pipeline failed');
    }
  }

  private async downloadMediaFor(messageId: string, msg: NormalizedMessage) {
    try {
      const buffer = await this.provider.downloadMedia(msg.raw);
      const media = await saveMediaBuffer(buffer, msg.mimeType ?? 'application/octet-stream', msg.filename);
      await prisma.message.update({ where: { id: messageId }, data: { mediaId: media.id } });
      const full = await prisma.message.findUnique({ where: { id: messageId }, include: messageInclude });
      if (full) emitStaff('message:updated', toMessageDTO(full));
    } catch (err) {
      logger.error({ err, messageId }, 'media download failed');
    }
  }

  async handleHistory(payload: { contacts: any[]; chats: any[]; messages: NormalizedMessage[] }) {
    logger.info(
      { contacts: payload.contacts.length, chats: payload.chats.length, messages: payload.messages.length },
      'ingesting history sync',
    );
    for (const c of payload.contacts) {
      if (!c.id) continue;
      // Prefer the saved address-book name over the self-set push name
      await this.handleContactUpdate({ jid: c.id, name: c.name ?? c.notify ?? null }).catch(() => {});
    }
    // Chat entries carry names too (for groups this is the subject)
    for (const c of payload.chats) {
      if (!c.id || !c.name) continue;
      await this.handleContactUpdate({ jid: c.id, name: c.name }).catch(() => {});
    }
    // Oldest first so quoted-message lookups can resolve
    const ordered = [...payload.messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    let done = 0;
    for (const m of ordered) {
      await this.handleMessage(m, { live: false });
      done += 1;
      if (done % 500 === 0) logger.info({ done, total: ordered.length }, 'history sync progress');
    }
    logger.info({ total: ordered.length }, 'history sync chunk ingested');
  }

  async handleStatusUpdates(updates: NormalizedStatusUpdate[]) {
    for (const u of updates) {
      try {
        const chat = await prisma.chat.findUnique({
          where: { waAccountId_jid: { waAccountId: this.waAccountId, jid: u.chatJid } },
          select: { id: true },
        });
        if (!chat) continue;
        const existing = await prisma.message.findUnique({
          where: { chatId_waMessageId: { chatId: chat.id, waMessageId: u.waMessageId } },
          select: { id: true, status: true },
        });
        if (!existing) continue;
        // Receipts can arrive out of order — never downgrade
        if ((STATUS_RANK[u.status] ?? 0) <= (STATUS_RANK[existing.status] ?? 0)) continue;
        await prisma.message.update({ where: { id: existing.id }, data: { status: u.status } });
        emitStaff('message:status', { chatId: chat.id, messageId: existing.id, status: u.status });
      } catch (err) {
        logger.error({ err }, 'status update failed');
      }
    }
  }

  async handleContactUpdate(update: { jid: string; name: string | null }) {
    if (!update.name) return;
    // LIDs can't be tied to a phone number here — don't create junk rows
    if (update.jid.endsWith('@lid') || update.jid === 'status@broadcast') return;
    const isGroup = update.jid.endsWith('@g.us');
    const contact = await prisma.contact.upsert({
      where: { waAccountId_jid: { waAccountId: this.waAccountId, jid: update.jid } },
      update: { pushName: update.name },
      create: {
        waAccountId: this.waAccountId,
        jid: update.jid,
        pushName: update.name,
        phone: isGroup ? null : update.jid.split('@')[0]!.split(':')[0]!,
        isGroup,
      },
    });
    // Refresh the sidebar entry if a chat exists for this contact
    const chatFull = await prisma.chat.findFirst({
      where: { waAccountId: this.waAccountId, contactId: contact.id },
      include: {
        contact: { include: { customer: { select: { name: true } } } },
        messages: { orderBy: { timestamp: 'desc' }, take: 1, include: messageInclude },
      },
    });
    if (chatFull) emitStaff('chat:updated', toChatDTO(chatFull));
  }
}
