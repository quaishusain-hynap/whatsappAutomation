import type { EventEmitter } from 'node:events';
import type { MessageType, WaStatusDTO } from '@mb/shared';

/** A provider-agnostic, normalized incoming/outgoing message event. */
export interface NormalizedMessage {
  waMessageId: string;
  chatJid: string;
  /** JID of the individual sender (differs from chatJid in groups). */
  senderJid: string;
  fromMe: boolean;
  pushName?: string | null;
  timestamp: Date;
  type: MessageType;
  body: string;
  quotedWaMessageId?: string | null;
  hasMedia: boolean;
  mimeType?: string | null;
  filename?: string | null;
  /** Original provider payload — persisted for media download & forward-compat. */
  raw: unknown;
}

export interface NormalizedStatusUpdate {
  chatJid: string;
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'played' | 'failed';
}

export interface SendResult {
  waMessageId: string;
  timestamp: Date;
}

export interface OutgoingMedia {
  buffer: Buffer;
  mimeType: string;
  filename?: string | null;
  caption?: string | null;
}

/**
 * Provider abstraction: Baileys today, WhatsApp Business Cloud API later.
 * Everything outside this module depends only on this interface.
 *
 * Events emitted on `events`:
 *  - 'qr' (qrDataUrl: string)
 *  - 'status' (status: WaStatusDTO)
 *  - 'message' (msg: NormalizedMessage)
 *  - 'message-status' (updates: NormalizedStatusUpdate[])
 */
export interface WhatsAppProvider {
  readonly kind: 'baileys' | 'cloud_api';
  readonly accountId: string;
  readonly events: EventEmitter;

  start(): Promise<void>;
  stop(): Promise<void>;
  /** Unlink the device entirely (wipes credentials). */
  logout(): Promise<void>;
  getStatus(): WaStatusDTO;

  /** Pre-generate a message id so the DB row can exist before the wire send. */
  generateMessageId(): string;
  sendText(jid: string, text: string, opts?: { messageId?: string; quotedRaw?: unknown }): Promise<SendResult>;
  sendMedia(jid: string, media: OutgoingMedia, opts?: { messageId?: string }): Promise<SendResult>;
  downloadMedia(raw: unknown): Promise<Buffer>;
  markRead(chatJid: string, messageIds: string[], participantJid?: string): Promise<void>;
}
