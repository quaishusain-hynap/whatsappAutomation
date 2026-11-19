import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireAuth } from '../auth/guard.js';
import { audit } from '../audit/audit.js';
import { sessionManager } from './session-manager.js';

export async function waRoutes(app: FastifyInstance) {
  app.get('/api/wa/status', { preHandler: requireAuth }, async (req) => {
    const status = sessionManager.getStatus();
    // QR is only exposed to admins
    if (req.user.role !== 'admin') return { ...status, qrDataUrl: null };
    return status;
  });

  app.post('/api/wa/connect', { preHandler: requireAdmin }, async (req) => {
    await sessionManager.connect();
    await audit({ userId: req.user.sub, action: 'wa.connect' });
    return sessionManager.getStatus();
  });

  app.post('/api/wa/logout', { preHandler: requireAdmin }, async (req) => {
    await sessionManager.logout();
    await audit({ userId: req.user.sub, action: 'wa.logout' });
    return sessionManager.getStatus();
  });
}
