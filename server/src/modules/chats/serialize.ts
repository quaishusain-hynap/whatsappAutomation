import type { ChatDTO, MessageDTO } from '@mb/shared';
import type { Chat, Contact, MediaFile, Message, User } from '@prisma/client';

type MessageWithRelations = Message & {
  sentBy?: Pick<User, 'id' | 'displayName'> | null;
  media?: MediaFile | null;
  quotedMessage?: Message | null;
};

export function toMessageDTO(m: MessageWithRelations, senderName?: string | null): MessageDTO {
  return {
    id: m.id,
    chatId: m.chatId,
    waMessageId: m.waMessageId,
    direction: m.direction,
    senderJid: m.senderJid,
    senderName: senderName ?? null,
    sentBy: m.sentBy ? { id: m.sentBy.id, displayName: m.sentBy.displayName } : null,
    type: m.type,
    body: m.body,
    quoted: m.quotedMessage
      ? { id: m.quotedMessage.id, body: m.quotedMessage.body, direction: m.quotedMessage.direction }
      : null,
    media: m.media
      ? {
          id: m.media.id,
          mimeType: m.media.mimeType,
          sizeBytes: m.media.sizeBytes,
          originalFilename: m.media.originalFilename,
        }
      : null,
    status: m.status,
    timestamp: m.timestamp.toISOString(),
  };
}

export function jidToPhone(jid: string): string {
  return jid.split('@')[0]!.split(':')[0]!;
}

export function chatDisplayName(contact: Contact, customerName?: string | null): string {
  if (customerName) return customerName;
  if (contact.pushName) return contact.pushName;
  if (contact.isGroup) return `Group ${jidToPhone(contact.jid)}`;
  return `+${jidToPhone(contact.jid)}`;
}

type ChatWithRelations = Chat & {
  contact: Contact & { customer?: { name: string } | null };
  messages?: MessageWithRelations[];
};

export function toChatDTO(c: ChatWithRelations): ChatDTO {
  const last = c.messages?.[0];
  let preview: string | null = null;
  if (last) {
    preview = last.body || (last.type !== 'text' ? `[${last.type}]` : '');
    if (last.direction === 'outbound') preview = `✓ ${preview}`;
  }
  return {
    id: c.id,
    jid: c.jid,
    name: chatDisplayName(c.contact, c.contact.customer?.name),
    isGroup: c.contact.isGroup,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: preview,
    unreadCount: c.unreadCount,
  };
}

export const messageInclude = {
  sentBy: { select: { id: true, displayName: true } },
  media: true,
  quotedMessage: true,
} as const;
