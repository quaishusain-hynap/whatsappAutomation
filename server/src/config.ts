import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  PORT: z.coerce.number().default(3001),
  DATA_DIR: z.string().default('./data'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  AI_PARSE_MODEL: z.string().default('claude-opus-5'),
  AI_CLASSIFY_MODEL: z.string().default('claude-opus-5'),
  NODE_ENV: z.string().default('development'),
});

const env = envSchema.parse(process.env);

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  dataDir: path.resolve(process.cwd(), env.DATA_DIR),
  accessTokenTtl: '12h' as const,
  refreshTokenTtlDays: 30,
};
