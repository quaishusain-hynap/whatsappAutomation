import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const createUserSchema = z.object({
  username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i),
  displayName: z.string().min(1).max(80),
  password: z.string().min(6),
  role: z.enum(['admin', 'agent']),
});

export const updateUserSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  password: z.string().min(6).optional(),
  role: z.enum(['admin', 'agent']).optional(),
  isActive: z.boolean().optional(),
});

export const sendMessageSchema = z.object({
  text: z.string().max(65536).optional(),
  mediaId: z.string().optional(),
  quotedMessageId: z.string().optional(),
}).refine((v) => v.text?.trim() || v.mediaId, {
  message: 'text or mediaId required',
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
