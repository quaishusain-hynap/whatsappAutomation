import { prisma } from '../../db.js';
import { logger } from '../../logger.js';

export async function audit(entry: {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: entry.details as object | undefined,
        ip: entry.ip,
      },
    });
  } catch (err) {
    logger.error({ err }, 'audit write failed');
  }
}
