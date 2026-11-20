import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import type { WaStatusDTO, WaConnStatus } from '@mb/shared';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { prisma } from '../../db.js';
import { normalizeBaileysMessage, mapBaileysStatus } from './normalize.js';
import type {
  LidPnPair,
  NormalizedMessage,
  NormalizedStatusUpdate,
  OutgoingMedia,
  SendResult,
  WhatsAppProvider,
} from './provider.js';
// Baileys 7 is ESM-only
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  jidNormalizedUser,
} from 'baileys';

const baileysLogger = pino({ level: 'silent' });

const isLid = (jid: unknown): jid is string => typeof jid === 'string' && jid.endsWith('@lid');
const isPn = (jid: unknown): jid is string =>
  typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');

/** Normalize a raw {lid, pn} pair to device-less JIDs, or null if it isn't one. */
function toPair(lid: unknown, pn: unknown): LidPnPair | null {
  if (typeof lid !== 'string' || typeof pn !== 'string') return null;
  const l = jidNormalizedUser(lid);
  const p = jidNormalizedUser(pn);
  return isLid(l) && isPn(p) ? { lid: l, pn: p } : null;
}

export class BaileysProvider implements WhatsAppProvider {
  readonly kind = 'baileys' as const;
  readonly events = new EventEmitter();

  private sock: any = null;
  private status: WaConnStatus = 'disconnected';
  private qrDataUrl: string | null = null;
  private phoneNumber: string | null = null;
  private reconnectAttempts = 0;
  private qrTimeouts = 0;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly accountId: string,
    private readonly authDir: string,
  ) {}

  private get authPath() {
    return path.join(config.dataDir, this.authDir);
  }

  getStatus(): WaStatusDTO {
    return {
      accountId: this.accountId,
      status: this.status,
      phoneNumber: this.phoneNumber,
      qrDataUrl: this.status === 'qr_pending' ? this.qrDataUrl : null,
    };
  }

  private setStatus(status: WaConnStatus) {
    this.status = status;
    this.events.emit('status', this.getStatus());
  }

  generateMessageId(): string {
    return generateMessageIDV2(this.sock?.user?.id);
  }

  private emitLidPairs(pairs: LidPnPair[]) {
    if (pairs.length) this.events.emit('lid-mapping', pairs);
  }

  /** Look up phone-number JIDs for LIDs in Baileys' persisted mapping store. */
  async lookupPhoneJids(lids: string[]): Promise<LidPnPair[]> {
    const mapping = this.sock?.signalRepository?.lidMapping;
    if (!mapping || lids.length === 0) return [];
    try {
      const res = (await mapping.getPNsForLIDs(lids)) ?? [];
      return res.map((r: any) => toPair(r?.lid, r?.pn)).filter((p: LidPnPair | null): p is LidPnPair => !!p);
    } catch (err) {
      logger.warn({ err }, 'LID lookup failed');
      return [];
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.qrTimeouts = 0;
    if (this.reconnectTimer) {
      // a delayed reconnect is pending — the user asked for it NOW
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      await this.connect();
      return;
    }
    // socket already live and progressing — nothing to do
    if (this.sock && (this.status === 'connecting' || this.status === 'qr_pending' || this.status === 'connected')) {
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus('connecting');

    fs.mkdirSync(this.authPath, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLogger,
      markOnlineOnConnect: false, // keep phone notifications ringing
      syncFullHistory: true, // pull complete chat history at pairing
      generateHighQualityLinkPreview: false,
      getMessage: async (key: any) => {
        const m = await prisma.message.findFirst({ where: { waMessageId: key.id ?? '' } });
        return (m?.raw as any)?.message ?? undefined;
      },
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 1 });
        this.reconnectAttempts = 0; // a QR means the socket itself is healthy
        this.setStatus('qr_pending');
        this.events.emit('qr', this.qrDataUrl);
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.qrTimeouts = 0;
        this.qrDataUrl = null;
        this.phoneNumber = sock.user?.id?.split(':')[0]?.split('@')[0] ?? null;
        this.setStatus('connected');
        logger.info({ phone: this.phoneNumber }, 'WhatsApp connected');
        void this.refreshGroupSubjects();
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          logger.warn('WhatsApp session logged out — credentials wiped, re-pair required');
          this.wipeAuth();
          this.setStatus('logged_out');
          return; // never reconnect-loop a logged-out session
        }
        if (this.stopped) {
          this.setStatus('disconnected');
          return;
        }
        // Unscanned QR: WhatsApp closes the socket (408) after a few QR cycles.
        // Show a fresh QR quickly instead of backing off; after 3 rounds pause
        // so we don't hammer WhatsApp while nobody is scanning.
        if (this.status === 'qr_pending' && statusCode === DisconnectReason.timedOut) {
          this.qrTimeouts += 1;
          if (this.qrTimeouts >= 3) {
            logger.info('QR not scanned — pausing. Click Connect to get a new QR.');
            this.qrDataUrl = null;
            this.setStatus('disconnected');
            return;
          }
          this.setStatus('connecting');
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
          }, 1500);
          return;
        }
        const delay = Math.min(60_000, 1000 * 2 ** this.reconnectAttempts) + Math.floor(Math.random() * 1000);
        this.reconnectAttempts += 1;
        logger.warn({ statusCode, delay }, 'WhatsApp connection closed, reconnecting');
        this.setStatus('connecting');
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.connect();
        }, delay);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      const live = type === 'notify' || type === 'append';
      for (const waMsg of messages) {
        await this.resolveLids(waMsg);
        const normalized = normalizeBaileysMessage(waMsg);
        if (normalized) this.events.emit('message', normalized, { live });
      }
    });

    sock.ev.on('messages.update', async (updates: any[]) => {
      const mapped: NormalizedStatusUpdate[] = [];
      for (const u of updates) {
        const status = typeof u.update?.status === 'number' ? mapBaileysStatus(u.update.status) : null;
        if (status && u.key?.remoteJid && u.key?.id) {
          // Receipts may also be addressed by LID — route them to the phone-number chat
          await this.resolveLids(u);
          mapped.push({ chatJid: u.key.remoteJid, waMessageId: u.key.id, status });
        }
      }
      if (mapped.length) this.events.emit('message-status', mapped);
    });

    // WhatsApp tells us which LID belongs to which number as it learns them
    sock.ev.on('lid-mapping.update', (m: any) => {
      const pair = toPair(m?.lid, m?.pn);
      if (pair) this.emitLidPairs([pair]);
    });

    sock.ev.on('messaging-history.set', async ({ contacts, chats, messages, lidPnMappings }: any) => {
      // Pairs first, so LID chats are merged before this chunk's messages land
      const pairs: LidPnPair[] = [];
      for (const m of lidPnMappings ?? []) {
        const p = toPair(m?.lid, m?.pn);
        if (p) pairs.push(p);
      }
      for (const c of [...(contacts ?? []), ...(chats ?? [])]) {
        const p = toPair(c?.lid ?? c?.lidJid ?? c?.id, c?.phoneNumber ?? c?.pnJid ?? c?.id);
        if (p) pairs.push(p);
      }
      this.emitLidPairs(pairs);

      const normalized: NormalizedMessage[] = [];
      for (const waMsg of messages ?? []) {
        await this.resolveLids(waMsg);
        const n = normalizeBaileysMessage(waMsg);
        if (n) normalized.push(n);
      }
      this.events.emit('history', {
        contacts: (contacts ?? []).map((c: any) => ({ ...c, id: this.preferPn(c) })),
        chats: (chats ?? []).map((c: any) => ({ ...c, id: this.preferPn(c) })),
        messages: normalized,
      });
    });

    const onContacts = (contacts: any[]) => {
      const pairs: LidPnPair[] = [];
      for (const c of contacts) {
        const p = toPair(c?.lid ?? c?.id, c?.phoneNumber ?? c?.id);
        if (p) pairs.push(p);
        const jid = this.preferPn(c);
        if (jid) this.events.emit('contact-update', { jid, name: c.name ?? c.notify ?? null });
      }
      this.emitLidPairs(pairs);
    };
    sock.ev.on('contacts.upsert', onContacts);
    sock.ev.on('contacts.update', onContacts);

    // Group subjects are not in contact events — they come as group metadata
    const onGroups = (groups: any[]) => {
      for (const g of groups) {
        if (g.id && g.subject) this.events.emit('contact-update', { jid: g.id, name: g.subject });
      }
    };
    sock.ev.on('groups.upsert', onGroups);
    sock.ev.on('groups.update', onGroups);
  }

  /**
   * Rewrite LID JIDs (…@lid) on a message key to real phone-number JIDs.
   * Sources, in order: alt fields WhatsApp attaches to the key, then the
   * library's own LID↔PN mapping store.
   */
  private async resolveLids(waMsg: any): Promise<void> {
    const key = waMsg?.key;
    if (!key) return;
    const learned: LidPnPair[] = [];
    const mapOne = async (jid: unknown, ...alts: unknown[]): Promise<string | null> => {
      if (!isLid(jid)) return null;
      for (const a of alts) {
        const p = toPair(jid, a);
        if (p) {
          learned.push(p);
          return p.pn;
        }
      }
      const [found] = await this.lookupPhoneJids([jid]);
      return found?.pn ?? null;
    };

    const remote = await mapOne(key.remoteJid, key.remoteJidAlt);
    if (remote) key.remoteJid = remote;
    const participant = await mapOne(key.participant, key.participantAlt);
    if (participant) key.participant = participant;
    this.emitLidPairs(learned);
  }

  /** The phone-number JID for a contact/chat record when known, else its id. */
  private preferPn(c: any): string | null {
    const id: unknown = c?.id;
    if (!isLid(id)) return typeof id === 'string' ? id : null;
    const pn = c?.phoneNumber ?? c?.pnJid;
    return typeof pn === 'string' && isPn(jidNormalizedUser(pn)) ? jidNormalizedUser(pn) : id;
  }

  /** Fetch subjects of all groups we participate in (run after connect). */
  private async refreshGroupSubjects() {
    try {
      const groups = await this.sock?.groupFetchAllParticipating?.();
      if (!groups) return;
      for (const g of Object.values<any>(groups)) {
        if (g.id && g.subject) this.events.emit('contact-update', { jid: g.id, name: g.subject });
      }
    } catch (err) {
      logger.warn({ err }, 'could not fetch group subjects');
    }
  }

  private wipeAuth() {
    try {
      fs.rmSync(this.authPath, { recursive: true, force: true });
    } catch (err) {
      logger.error({ err }, 'failed to wipe auth dir');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.end?.(undefined);
    } catch { /* ignore */ }
    this.sock = null;
    this.setStatus('disconnected');
  }

  async logout(): Promise<void> {
    try {
      await this.sock?.logout?.();
    } catch { /* may already be dead */ }
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock = null;
    this.wipeAuth();
    this.setStatus('logged_out');
  }

  private ensureConnected() {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('WhatsApp is not connected');
    }
  }

  async sendText(jid: string, text: string, opts?: { messageId?: string; quotedRaw?: unknown }): Promise<SendResult> {
    this.ensureConnected();
    const sent = await this.sock.sendMessage(
      jid,
      { text },
      {
        messageId: opts?.messageId,
        quoted: opts?.quotedRaw ?? undefined,
      },
    );
    return { waMessageId: sent?.key?.id ?? opts?.messageId ?? '', timestamp: new Date() };
  }

  async sendMedia(jid: string, media: OutgoingMedia, opts?: { messageId?: string }): Promise<SendResult> {
    this.ensureConnected();
    const caption = media.caption ?? undefined;
    let content: Record<string, unknown>;
    if (media.mimeType.startsWith('image/') && media.mimeType !== 'image/webp') {
      content = { image: media.buffer, caption };
    } else if (media.mimeType.startsWith('video/')) {
      content = { video: media.buffer, caption };
    } else if (media.mimeType.startsWith('audio/')) {
      content = { audio: media.buffer, mimetype: media.mimeType };
    } else {
      content = {
        document: media.buffer,
        mimetype: media.mimeType,
        fileName: media.filename ?? 'file',
        caption,
      };
    }
    const sent = await this.sock.sendMessage(jid, content, { messageId: opts?.messageId });
    return { waMessageId: sent?.key?.id ?? opts?.messageId ?? '', timestamp: new Date() };
  }

  async downloadMedia(raw: unknown): Promise<Buffer> {
    if (!this.sock) throw new Error('WhatsApp is not connected');
    return (await downloadMediaMessage(raw as any, 'buffer', {}, {
      logger: baileysLogger,
      reuploadRequest: this.sock.updateMediaMessage,
    })) as Buffer;
  }

  async markRead(chatJid: string, messageIds: string[], participantJid?: string): Promise<void> {
    if (!this.sock || this.status !== 'connected') return;
    await this.sock.readMessages(
      messageIds.map((id) => ({ remoteJid: chatJid, id, participant: participantJid })),
    );
  }
}
