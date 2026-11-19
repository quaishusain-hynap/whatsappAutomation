import type { MessageType } from '@mb/shared';
import type { NormalizedMessage } from './provider.js';

type AnyMsg = Record<string, any>;

/** Unwrap ephemeral / view-once / caption wrappers to the real content. */
function unwrapContent(message: AnyMsg | null | undefined): AnyMsg | null {
  if (!message) return null;
  if (message.ephemeralMessage) return unwrapContent(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrapContent(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrapContent(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension) return unwrapContent(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage) return unwrapContent(message.documentWithCaptionMessage.message);
  if (message.editedMessage) return unwrapContent(message.editedMessage.message?.protocolMessage?.editedMessage ?? null);
  return message;
}

function tsToDate(t: unknown): Date {
  if (typeof t === 'number') return new Date(t * 1000);
  if (t && typeof (t as any).toNumber === 'function') return new Date((t as any).toNumber() * 1000);
  if (typeof t === 'string') return new Date(Number(t) * 1000);
  return new Date();
}

/**
 * Convert a raw Baileys WAMessage into the provider-agnostic shape.
 * Returns null for messages we deliberately ignore (protocol updates,
 * reactions, polls, broadcast statuses).
 */
export function normalizeBaileysMessage(waMsg: AnyMsg): NormalizedMessage | null {
  const key = waMsg.key;
  if (!key?.remoteJid || !key.id) return null;
  if (key.remoteJid === 'status@broadcast') return null;

  const content = unwrapContent(waMsg.message);
  if (!content) return null;

  // Ignore non-chat payloads
  if (
    content.protocolMessage ||
    content.senderKeyDistributionMessage && Object.keys(content).length === 1 ||
    content.reactionMessage ||
    content.pollCreationMessage ||
    content.pollUpdateMessage
  ) {
    return null;
  }

  let type: MessageType = 'text';
  let body = '';
  let hasMedia = false;
  let mimeType: string | null = null;
  let filename: string | null = null;
  let contextInfo: AnyMsg | undefined;

  if (typeof content.conversation === 'string') {
    body = content.conversation;
  } else if (content.extendedTextMessage) {
    body = content.extendedTextMessage.text ?? '';
    contextInfo = content.extendedTextMessage.contextInfo;
  } else if (content.imageMessage) {
    type = 'image';
    body = content.imageMessage.caption ?? '';
    hasMedia = true;
    mimeType = content.imageMessage.mimetype ?? 'image/jpeg';
    contextInfo = content.imageMessage.contextInfo;
  } else if (content.videoMessage) {
    type = 'video';
    body = content.videoMessage.caption ?? '';
    hasMedia = true;
    mimeType = content.videoMessage.mimetype ?? 'video/mp4';
    contextInfo = content.videoMessage.contextInfo;
  } else if (content.audioMessage) {
    type = 'audio';
    hasMedia = true;
    mimeType = content.audioMessage.mimetype ?? 'audio/ogg';
  } else if (content.documentMessage) {
    type = 'document';
    body = content.documentMessage.caption ?? '';
    hasMedia = true;
    mimeType = content.documentMessage.mimetype ?? 'application/octet-stream';
    filename = content.documentMessage.fileName ?? null;
    contextInfo = content.documentMessage.contextInfo;
  } else if (content.stickerMessage) {
    type = 'sticker';
    hasMedia = true;
    mimeType = content.stickerMessage.mimetype ?? 'image/webp';
  } else if (content.locationMessage) {
    type = 'location';
    body = `${content.locationMessage.degreesLatitude},${content.locationMessage.degreesLongitude}`;
  } else if (content.contactMessage) {
    type = 'contact';
    body = content.contactMessage.displayName ?? 'Contact';
  } else if (content.contactsArrayMessage) {
    type = 'contact';
    body = `${content.contactsArrayMessage.contacts?.length ?? 0} contacts`;
  } else {
    return null; // unknown content type — skip rather than store garbage
  }

  // WhatsApp may address users by an anonymous LID (…@lid) instead of the
  // phone-number JID. Prefer the *Alt fields which carry the real number,
  // otherwise a phone-echo and an app-send would land in two different chats.
  const resolveJid = (jid: string | null | undefined, alt: string | null | undefined): string | null => {
    if (!jid) return null;
    if (jid.endsWith('@lid') && alt) return alt;
    return jid;
  };

  const chatJid = resolveJid(key.remoteJid, key.remoteJidAlt ?? waMsg.remoteJidAlt)!;
  const isGroup = chatJid.endsWith('@g.us');
  const senderJid: string = key.fromMe
    ? 'me'
    : isGroup
      ? (resolveJid(key.participant, key.participantAlt ?? waMsg.participantAlt) ?? chatJid)
      : chatJid;

  return {
    waMessageId: key.id,
    chatJid,
    senderJid,
    fromMe: !!key.fromMe,
    pushName: waMsg.pushName ?? null,
    timestamp: tsToDate(waMsg.messageTimestamp),
    type,
    body,
    quotedWaMessageId: contextInfo?.stanzaId ?? null,
    hasMedia,
    mimeType,
    filename,
    raw: waMsg,
  };
}

/** Map Baileys numeric WAMessageStatus to our enum. */
export function mapBaileysStatus(status: number): 'sent' | 'delivered' | 'read' | 'played' | null {
  switch (status) {
    case 2: return 'sent';
    case 3: return 'delivered';
    case 4: return 'read';
    case 5: return 'played';
    default: return null;
  }
}
