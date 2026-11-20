import type { ChatDTO, MessageDTO, MessageStatus, WaStatusDTO } from './types.js';

/** Events the server emits to clients */
export interface ServerToClientEvents {
  'message:new': (msg: MessageDTO) => void;
  'message:updated': (msg: MessageDTO) => void;
  'message:status': (payload: { chatId: string; messageId: string; status: MessageStatus }) => void;
  'chat:updated': (chat: ChatDTO) => void;
  /** `fromChatId` (an anonymous-LID duplicate) was folded into `intoChatId` and no longer exists. */
  'chat:merged': (payload: { fromChatId: string; intoChatId: string }) => void;
  'wa:status': (status: WaStatusDTO) => void;
}

/** Events clients emit to the server */
export interface ClientToServerEvents {
  'chat:focus': (chatId: string) => void;
}
