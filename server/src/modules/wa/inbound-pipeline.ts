import { logger } from '../../logger.js';
import { prisma } from '../../db.js';
import { emitStaff } from '../../realtime.js';
import { saveMediaBuffer } from '../media/storage.js';
import { messageInclude, toChatDTO, toMessageDTO } from '../chats/serialize.js';
import type { LidPnPair, NormalizedMessage, NormalizedStatusUpdate, WhatsAppProvider } from './provider.js';

const STATUS_RANK: Record<string, number> = {
  pending: 0, failed: 0, sent: 1, delivered: 2, read: 3, played: 4,
};

export class InboundPipeline {
  /** LIDs already merged (or being merged) this process — pairs repeat constantly. */
  private readonly mergedLids = new Set<string>();
  /** Merges run one at a time so two pairs for one chat never race. */
  private mergeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly waAccountId: string,
    private readonly provider: WhatsAppProvider,
  ) {}

  /**
   * WhatsApp revealed which phone number sits behind some anonymous LIDs:
   * fold any chat/contact we stored under a LID into the phone-number one.
   */
  handleLidMappings(pairs: LidPnPair[]): Promise<void> {
    const fresh = pairs.filter((p) => !this.mergedLids.has(p.lid));
    if (fresh.length === 0) return this.mergeQueue;
    for (const p of fresh) this.mergedLids.add(p.lid);
    this.mergeQueue = this.mergeQueue.then(async () => {
      for (const p of fresh) {
        try {
          await this.mergeLid(p);
        } catch (err) {
          this.mergedLids.delete(p.lid); // let a later pair retry it
          logger.error({ err, lid: p.lid }, 'LID merge failed');
        }
      }
    });
    return this.mergeQueue;
  }

  /** Startup sweep: resolve every LID chat/contact still in the DB via the provider's store. */
  async repairLidChats() {
    if (!this.provider.lookupPhoneJids) return;
    const rows = await prisma.contact.findMany({
      where: { waAccountId: this.waAccountId, jid: { endsWith: '@lid' } },
      select: { jid: true },
    });
    const senders = await prisma.message.findMany({
      where: { chat: { waAccountId: this.waAccountId }, senderJid: { endsWith: '@lid' } },
      distinct: ['senderJid'],
      select: { senderJid: true },
    });
    const lids = [...new Set([...rows.map((r) => r.jid), ...senders.map((s) => s.senderJid!)])];
    if (lids.length === 0) return;
    const pairs = await this.provider.lookupPhoneJids(lids);
    logger.info({ lids: lids.length, resolved: pairs.length }, 'LID repair sweep');
    await this.handleLidMappings(pairs);
  }

  private async mergeLid({ lid, pn }: LidPnPair) {
    const acc = this.waAccountId;
    const phone = pn.split('@')[0]!;

    // Group messages remember the sender — point those at the number too
    await prisma.message.updateMany({
      where: { chat: { waAccountId: acc }, senderJid: lid },
      data: { senderJid: pn },
    });

    const result = await prisma.$transaction(async (tx) => {
      const lidContact = await tx.contact.findUnique({
        where: { waAccountId_jid: { waAccountId: acc, jid: lid } },
        include: { customer: { select: { id: true } } },
      });
      const lidChat = await tx.chat.findUnique({ where: { waAccountId_jid: { waAccountId: acc, jid: lid } } });
      if (!lidContact && !lidChat) return null;

      // 1. Contact: rename the LID row, or fold it into the existing number row
      let pnContact = await tx.contact.findUnique({
        where: { waAccountId_jid: { waAccountId: acc, jid: pn } },
        include: { customer: { select: { id: true } } },
      });
      if (!pnContact && lidContact) {
        pnContact = await tx.contact.update({
          where: { id: lidContact.id },
          data: { jid: pn, phone },
          include: { customer: { select: { id: true } } },
        });
      } else if (pnContact && lidContact) {
        if (!pnContact.pushName && lidContact.pushName) {
          await tx.contact.update({ where: { id: pnContact.id }, data: { pushName: lidContact.pushName } });
        }
        if (lidContact.customer && !pnContact.customer) {
          await tx.customer.update({ where: { id: lidContact.customer.id }, data: { contactId: pnContact.id } });
        }
      } else if (!pnContact) {
        pnContact = await tx.contact.create({
          data: { waAccountId: acc, jid: pn, phone, isGroup: false },
          include: { customer: { select: { id: true } } },
        });
      }

      // 2. Chat: rename the LID chat, or move its history into the number chat
      let intoChatId: string | null = null;
      let fromChatId: string | null = null;
      if (lidChat) {
        const pnChat = await tx.chat.findUnique({ where: { waAccountId_jid: { waAccountId: acc, jid: pn } } });
        if (!pnChat) {
          await tx.chat.update({ where: { id: lidChat.id }, data: { jid: pn, contactId: pnContact!.id } });
          intoChatId = lidChat.id;
        } else {
          // Same WhatsApp message stored in both chats: keep the number chat's
          // copy, repoint anything referencing the LID copy, then drop it.
          const dups = await tx.$queryRaw<{ lid_id: string; pn_id: string }[]>`
            select l.id as lid_id, p.id as pn_id
            from messages l join messages p on p.wa_message_id = l.wa_message_id
            where l.chat_id = ${lidChat.id} and p.chat_id = ${pnChat.id}`;
          for (const d of dups) {
            await tx.message.updateMany({ where: { quotedMessageId: d.lid_id }, data: { quotedMessageId: d.pn_id } });
            await tx.document.updateMany({ where: { messageId: d.lid_id }, data: { messageId: d.pn_id } });
          }
          if (dups.length) await tx.message.deleteMany({ where: { id: { in: dups.map((d) => d.lid_id) } } });

          const move = { where: { chatId: lidChat.id }, data: { chatId: pnChat.id } };
          await tx.message.updateMany(move);
          await tx.document.updateMany(move);
          await tx.fareQuote.updateMany(move);
          await tx.booking.updateMany(move);
          await tx.workflowRun.updateMany(move);

          const last = [pnChat.lastMessageAt, lidChat.lastMessageAt]
            .filter((d): d is Date => !!d)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
          await tx.chat.update({
            where: { id: pnChat.id },
            data: {
              lastMessageAt: last,
              unreadCount: pnChat.unreadCount + lidChat.unreadCount,
              assignedUserId: pnChat.assignedUserId ?? lidChat.assignedUserId,
            },
          });
          await tx.chat.delete({ where: { id: lidChat.id } });
          intoChatId = pnChat.id;
          fromChatId = lidChat.id;
        }
      }

      // 3. Drop the leftover LID contact once nothing points at it
      if (lidContact && lidContact.id !== pnContact!.id) {
        const [chats, customer] = await Promise.all([
          tx.chat.count({ where: { contactId: lidContact.id } }),
          tx.customer.count({ where: { contactId: lidContact.id } }),
        ]);
        if (chats === 0 && customer === 0) await tx.contact.delete({ where: { id: lidContact.id } });
      }
      return { intoChatId, fromChatId };
    });

    if (!result) return;
    logger.info({ lid, pn, merged: !!result.fromChatId }, 'LID chat resolved to phone number');
    if (result.fromChatId && result.intoChatId) {
      emitStaff('chat:merged', { fromChatId: result.fromChatId, intoChatId: result.intoChatId });
    }
    if (result.intoChatId) {
      const chatFull = await prisma.chat.findUnique({
        where: { id: result.intoChatId },
        include: {
          contact: { include: { customer: { select: { name: true } } } },
          messages: { orderBy: { timestamp: 'desc' }, take: 1, include: messageInclude },
        },
      });
      if (chatFull) emitStaff('chat:updated', toChatDTO(chatFull));
    }
  }

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
