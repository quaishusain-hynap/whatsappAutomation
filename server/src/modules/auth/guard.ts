import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken, type AccessTokenPayload } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: AccessTokenPayload;
  }
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  // Query-param fallback so <img>/<a> tags can load protected media
  const q = (req.query as Record<string, string> | undefined)?.token;
  return q ?? null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = extractToken(req);
  if (!token) return reply.code(401).send({ error: 'unauthorized' });
  try {
    req.user = verifyAccessToken(token);
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (req.user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
}
