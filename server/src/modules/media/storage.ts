import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import type { MediaFile } from '@prisma/client';

/** Persist a buffer under DATA_DIR/media/yyyy-MM/ and create its media_files row. */
export async function saveMediaBuffer(
  buffer: Buffer,
  mimeType: string,
  originalFilename?: string | null,
): Promise<MediaFile> {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  // Dedupe identical files
  const existing = await prisma.mediaFile.findFirst({ where: { sha256, sizeBytes: buffer.length } });
  if (existing) return existing;

  const now = new Date();
  const subdir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ext = (originalFilename ? path.extname(originalFilename).slice(1) : '') || mime.extension(mimeType) || 'bin';

  const row = await prisma.mediaFile.create({
    data: {
      filePath: '', // patched below once we know the id
      mimeType,
      sizeBytes: buffer.length,
      sha256,
      originalFilename: originalFilename ?? null,
    },
  });

  const relPath = path.join('media', subdir, `${row.id}.${ext}`);
  const absPath = path.join(config.dataDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buffer);

  return prisma.mediaFile.update({ where: { id: row.id }, data: { filePath: relPath } });
}

export function mediaAbsolutePath(media: MediaFile): string {
  return path.join(config.dataDir, media.filePath);
}
