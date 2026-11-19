import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { requireAuth } from '../auth/guard.js';
import { mediaAbsolutePath, saveMediaBuffer } from './storage.js';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export async function mediaRoutes(app: FastifyInstance) {
  app.post('/api/media', { preHandler: requireAuth }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) return reply.code(400).send({ error: 'no file' });
    const buffer = await file.toBuffer();
    const media = await saveMediaBuffer(buffer, file.mimetype, file.filename);
    return {
      media: {
        id: media.id,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        originalFilename: media.originalFilename,
      },
    };
  });

  app.get('/api/media/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const media = await prisma.mediaFile.findUnique({ where: { id } });
    if (!media || !media.filePath) return reply.code(404).send({ error: 'not found' });
    const abs = mediaAbsolutePath(media);
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: 'file missing' });

    reply.header('Content-Type', media.mimeType);
    reply.header('Content-Length', media.sizeBytes);
    if (media.originalFilename) {
      reply.header(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(media.originalFilename)}"`,
      );
    }
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(abs));
  });
}
