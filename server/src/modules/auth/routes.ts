import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { loginSchema } from '@mb/shared';
import { prisma } from '../../db.js';
import { audit } from '../audit/audit.js';
import { requireAuth } from './guard.js';
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from './tokens.js';
import { config } from '../../config.js';

const REFRESH_COOKIE = 'mb_refresh';

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProd,
  path: '/api/auth',
  maxAge: config.refreshTokenTtlDays * 24 * 3600,
};

function toUserDTO(u: { id: string; username: string; displayName: string; role: string; isActive: boolean }) {
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, isActive: u.isActive };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });

    const user = await prisma.user.findUnique({ where: { username: body.data.username } });
    if (!user || !user.isActive || !(await argon2.verify(user.passwordHash, body.data.password))) {
      await audit({ action: 'auth.login_failed', details: { username: body.data.username }, ip: req.ip });
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    const accessToken = signAccessToken({
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
    const refreshToken = await issueRefreshToken(user.id);
    await audit({ userId: user.id, action: 'auth.login', ip: req.ip });

    reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts);
    return { accessToken, user: toUserDTO(user) };
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) return reply.code(401).send({ error: 'no refresh token' });
    const rotated = await rotateRefreshToken(token);
    if (!rotated) return reply.code(401).send({ error: 'invalid refresh token' });

    const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
    if (!user || !user.isActive) return reply.code(401).send({ error: 'user disabled' });

    reply.setCookie(REFRESH_COOKIE, rotated.newToken, cookieOpts);
    const accessToken = signAccessToken({
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
    return { accessToken, user: toUserDTO(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await revokeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    return { user: user ? toUserDTO(user) : null };
  });
}
