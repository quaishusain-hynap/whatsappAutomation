import fs from 'node:fs';
import PQueue from 'p-queue';
import { logger } from '../../logger.js';
import { prisma } from '../../db.js';
import { emitStaff } from '../../realtime.js';
import { audit } from '../audit/audit.js';
import { mediaAbsolutePath } from '../media/storage.js';
import { messageInclude, toChatDTO, toMessageDTO } from '../chats/serialize.js';
import type { MessageDTO } from '@mb/shared';
import type { WhatsAppProvider } from './provider.js';

/**
 * The ONLY path to the wire for outgoing messages.
 * Serialized (concurrency 1) with randomized human-like pacing — the main
 * automation-detection mitigation. The DB row (with staff attribution) is
 * created BEFORE the send, so attribution is never inferred after the fact.
 */
export class SendQueue {
  private queue = new PQueue({ concurrency: 1 });

  constructor(private readonly provider: WhatsAppProvider) {}

  async enqueue(params: {
    chatId: string;
    userId: string;
    text?: string;
    mediaId?: string;
    quotedMessageId?: string;
  }): Promise<MessageDTO> {
    const chat = await prisma.chat.findUnique({ where: { id: params.chatId } });
    if (!chat) throw new Error('chat not found');

    const media = params.mediaId
      ? await prisma.mediaFile.findUnique({ where: { id: params.mediaId } })
      : null;
    if (params.mediaId && !media) throw new Error('media not found');

    const quoted = params.quotedMessageId
      ? await prisma.message.findUnique({ where: { id: params.quotedMessageId } })
      : null;

    const waMessageId = this.provider.generateMessageId();
    const type = media
      ? media.mimeType.startsWith('image/') ? 'image'
        : media.mimeType.startsWith('video/') ? 'video'
        : media.mimeType.startsWith('audio/') ? 'audio'
        : 'document'
      : 'text';

    const row = await prisma.message.create({
      data: {
        chatId: chat.id,
        waMessageId,
        direction: 'outbound',
        senderJid: 'me',
        sentByUserId: params.userId,
        type,
        body: params.text ?? '',
        quotedMessageId: quoted?.id ?? null,
        mediaId: media?.id ?? null,
        status: 'pending',
        timestamp: new Date(),
      },
      include: messageInclude,
    });
    await prisma.chat.update({ where: { id: chat.id }, data: { lastMessageAt: row.timestamp } });

    const dto = toMessageDTO(row);
    emitStaff('message:new', dto);
    void this.emitChatUpdated(chat.id);

    void this.queue.add(async () => {
      // Human-like pacing between consecutive sends
      await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 1000)));
      try {
        if (media) {
          const buffer = fs.readFileSync(mediaAbsolutePath(media));
          await this.provider.sendMedia(
            chat.jid,
            {
              buffer,
              mimeType: media.mimeType,
              filename: media.originalFilename,
              caption: params.text || null,
            },
            { messageId: waMessageId },
          );
        } else {
          await this.provider.sendText(chat.jid, params.text ?? '', {
            messageId: waMessageId,
            quotedRaw: quoted?.raw ?? undefined,
          });
        }
        await prisma.message.updateMany({
          where: { id: row.id, status: 'pending' },
          data: { status: 'sent' },
        });
        emitStaff('message:status', { chatId: chat.id, messageId: row.id, status: 'sent' });
        await audit({
          userId: params.userId,
          action: 'message.send',
          entityType: 'message',
          entityId: row.id,
          details: { chatId: chat.id, type },
        });
      } catch (err) {
        logger.error({ err, messageId: row.id }, 'send failed');
        await prisma.message.update({ where: { id: row.id }, data: { status: 'failed' } });
        emitStaff('message:status', { chatId: chat.id, messageId: row.id, status: 'failed' });
      }
    });

    return dto;
  }

  /** Re-attempt a failed message (same row, same attribution). */
  async retry(messageId: string): Promise<void> {
    const row = await prisma.message.findUnique({ where: { id: messageId }, include: { media: true, chat: true } });
    if (!row || row.status !== 'failed' || row.direction !== 'outbound') throw new Error('not retryable');
    await prisma.message.update({ where: { id: row.id }, data: { status: 'pending' } });
    emitStaff('message:status', { chatId: row.chatId, messageId: row.id, status: 'pending' });

    void this.queue.add(async () => {
      await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 1000)));
      try {
        if (row.media) {
          const buffer = fs.readFileSync(mediaAbsolutePath(row.media));
          await this.provider.sendMedia(
            row.chat.jid,
            { buffer, mimeType: row.media.mimeType, filename: row.media.originalFilename, caption: row.body || null },
            { messageId: row.waMessageId },
          );
        } else {
          await this.provider.sendText(row.chat.jid, row.body, { messageId: row.waMessageId });
        }
        await prisma.message.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'sent' } });
        emitStaff('message:status', { chatId: row.chatId, messageId: row.id, status: 'sent' });
      } catch (err) {
        logger.error({ err, messageId: row.id }, 'retry failed');
        await prisma.message.update({ where: { id: row.id }, data: { status: 'failed' } });
        emitStaff('message:status', { chatId: row.chatId, messageId: row.id, status: 'failed' });
      }
    });
  }

  private async emitChatUpdated(chatId: string) {
    const chatFull = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        contact: { include: { customer: { select: { name: true } } } },
        messages: { orderBy: { timestamp: 'desc' }, take: 1, include: messageInclude },
      },
    });
    if (chatFull) emitStaff('chat:updated', toChatDTO(chatFull));
  }
}
