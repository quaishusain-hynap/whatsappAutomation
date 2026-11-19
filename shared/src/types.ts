export type Role = 'admin' | 'agent';

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
}

export type WaConnStatus =
  | 'disconnected'
  | 'qr_pending'
  | 'connecting'
  | 'connected'
  | 'logged_out';

export interface WaStatusDTO {
  accountId: string;
  status: WaConnStatus;
  phoneNumber?: string | null;
  qrDataUrl?: string | null;
  lastConnectedAt?: string | null;
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'reaction'
  | 'system';
export type MessageStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'played'
  | 'failed';

export interface MediaDTO {
  id: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename?: string | null;
}

export interface MessageDTO {
  id: string;
  chatId: string;
  waMessageId: string;
  direction: MessageDirection;
  senderJid?: string | null;
  /** Resolved display name of the sender (group messages) */
  senderName?: string | null;
  /** Staff attribution: who sent this outbound message */
  sentBy?: { id: string; displayName: string } | null;
  type: MessageType;
  body: string;
  quoted?: { id: string; body: string; direction: MessageDirection } | null;
  media?: MediaDTO | null;
  status: MessageStatus;
  timestamp: string; // ISO
}

export interface ChatDTO {
  id: string;
  jid: string;
  name: string;
  isGroup: boolean;
  avatarUrl?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  unreadCount: number;
}

export interface LoginResponse {
  accessToken: string;
  user: UserDTO;
}
