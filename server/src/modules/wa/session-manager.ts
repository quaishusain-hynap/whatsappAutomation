import fs from 'node:fs';
import path from 'node:path';
import type { WaStatusDTO } from '@mb/shared';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { prisma } from '../../db.js';
import { emitAdmin, emitStaff } from '../../realtime.js';
import { BaileysProvider } from './baileys.provider.js';
import { InboundPipeline } from './inbound-pipeline.js';
import { SendQueue } from './send-queue.js';
import type { WhatsAppProvider } from './provider.js';

/**
 * Owns the (single, for now) WhatsApp account: provider lifecycle,
 * DB status mirroring, and wiring provider events into the pipeline.
 */
class SessionManager {
  private provider: WhatsAppProvider | null = null;
  private pipeline: InboundPipeline | null = null;
  sendQueue: SendQueue | null = null;
  private accountId: string | null = null;

  async init() {
    const account = await prisma.waAccount.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!account) {
      logger.warn('no wa_account row — run the seed first');
      return;
    }
    this.accountId = account.id;

    const provider = new BaileysProvider(account.id, account.authDir);
    this.provider = provider;
    this.pipeline = new InboundPipeline(account.id, provider);
    this.sendQueue = new SendQueue(provider);

    provider.events.on('status', (status: WaStatusDTO) => {
      void this.persistStatus(status);
      // QR only goes to admins; general status to everyone
      emitStaff('wa:status', { ...status, qrDataUrl: null });
      if (status.qrDataUrl) emitAdmin('wa:status', status);
    });
    provider.events.on('message', (msg, opts) => void this.pipeline!.handleMessage(msg, opts));
    provider.events.on('history', (payload) => void this.pipeline!.handleHistory(payload));
    provider.events.on('message-status', (updates) => void this.pipeline!.handleStatusUpdates(updates));
    provider.events.on('contact-update', (u) => void this.pipeline!.handleContactUpdate(u));
    provider.events.on('lid-mapping', (pairs) => void this.pipeline!.handleLidMappings(pairs));
    // Each time we connect, fix chats stored under an anonymous LID whose number is now known
    provider.events.on('status', (status: WaStatusDTO) => {
      if (status.status === 'connected') {
        void this.pipeline!.repairLidChats().catch((err) => logger.error({ err }, 'LID repair failed'));
      }
    });

    // Auto-connect if we already have credentials from a previous pairing
    const credsFile = path.join(config.dataDir, account.authDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      logger.info('existing WhatsApp credentials found — auto-connecting');
      void provider.start();
    } else {
      await prisma.waAccount.update({ where: { id: account.id }, data: { status: 'disconnected' } });
    }
  }

  private async persistStatus(status: WaStatusDTO) {
    if (!this.accountId) return;
    try {
      await prisma.waAccount.update({
        where: { id: this.accountId },
        data: {
          status: status.status,
          ...(status.status === 'connected'
            ? { lastConnectedAt: new Date(), phoneNumber: status.phoneNumber ?? undefined }
            : {}),
        },
      });
    } catch (err) {
      logger.error({ err }, 'failed to persist wa status');
    }
  }

  getStatus(): WaStatusDTO {
    return (
      this.provider?.getStatus() ?? {
        accountId: this.accountId ?? '',
        status: 'disconnected',
      }
    );
  }

  async connect() {
    if (!this.provider) throw new Error('no wa account configured');
    // start() is idempotent: it cancels pending reconnect delays and is a
    // no-op when the socket is already live, so a user click always helps.
    await this.provider.start();
  }

  async logout() {
    if (!this.provider) throw new Error('no wa account configured');
    await this.provider.logout();
  }

  async markRead(chatJid: string, messageIds: string[]) {
    await this.provider?.markRead(chatJid, messageIds);
  }

  async stop() {
    await this.provider?.stop();
  }
}

export const sessionManager = new SessionManager();
