import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { createUserSchema, updateUserSchema } from '@mb/shared';
import { prisma } from '../../db.js';
import { audit } from '../audit/audit.js';
import { requireAdmin } from './guard.js';

export async function adminUserRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/users', async () => {
    const users = await prisma.user.findMany({
      where: { role: { not: 'system' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, username: true, displayName: true, role: true, isActive: true, createdAt: true },
    });
    return { users };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const body = createUserSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'invalid body' });
    const exists = await prisma.user.findUnique({ where: { username: body.data.username } });
    if (exists) return reply.code(409).send({ error: 'username already taken' });

    const user = await prisma.user.create({
      data: {
        username: body.data.username,
        displayName: body.data.displayName,
        role: body.data.role,
        passwordHash: await argon2.hash(body.data.password),
      },
    });
    await audit({ userId: req.user.sub, action: 'user.create', entityType: 'user', entityId: user.id });
    return { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, isActive: user.isActive } };
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = updateUserSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });

    const data: Record<string, unknown> = {};
    if (body.data.displayName) data.displayName = body.data.displayName;
    if (body.data.role) data.role = body.data.role;
    if (typeof body.data.isActive === 'boolean') data.isActive = body.data.isActive;
    if (body.data.password) data.passwordHash = await argon2.hash(body.data.password);

    const user = await prisma.user.update({ where: { id }, data });
    await audit({ userId: req.user.sub, action: 'user.update', entityType: 'user', entityId: id, details: { fields: Object.keys(data) } });
    return { user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, isActive: user.isActive } };
  });

  app.get('/api/admin/audit', async (req) => {
    const { userId, action, limit } = req.query as { userId?: string; action?: string; limit?: string };
    const entries = await prisma.auditLog.findMany({
      where: {
        ...(userId ? { userId } : {}),
        ...(action ? { action: { contains: action } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit) || 100, 500),
      include: { user: { select: { username: true, displayName: true } } },
    });
    return { entries };
  });
}
