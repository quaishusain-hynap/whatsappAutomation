import { create } from 'zustand';
import type { ChatDTO, MessageDTO, MessageStatus, WaStatusDTO } from '@mb/shared';
import { api } from '../api/client.ts';

function sortChats(chats: ChatDTO[]): ChatDTO[] {
  return [...chats].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}

interface ChatState {
  chats: ChatDTO[];
  chatsLoaded: boolean;
  activeChatId: string | null;
  messages: Record<string, MessageDTO[]>;
  hasMore: Record<string, boolean>;
  replyTo: MessageDTO | null;
  waStatus: WaStatusDTO | null;

  loadChats: (search?: string) => Promise<void>;
  openChat: (chatId: string) => Promise<void>;
  loadOlder: (chatId: string) => Promise<void>;
  sendMessage: (input: { text?: string; mediaId?: string }) => Promise<void>;
  retryMessage: (chatId: string, messageId: string) => Promise<void>;
  setReplyTo: (m: MessageDTO | null) => void;

  // socket handlers
  onNewMessage: (m: MessageDTO) => void;
  onMessageUpdated: (m: MessageDTO) => void;
  onMessageStatus: (p: { chatId: string; messageId: string; status: MessageStatus }) => void;
  onChatUpdated: (c: ChatDTO) => void;
  setWaStatus: (s: WaStatusDTO) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  chatsLoaded: false,
  activeChatId: null,
  messages: {},
  hasMore: {},
  replyTo: null,
  waStatus: null,

  async loadChats(search) {
    const data = await api<{ chats: ChatDTO[] }>(
      `/api/chats${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    );
    set({ chats: sortChats(data.chats), chatsLoaded: true });
  },

  async openChat(chatId) {
    set({ activeChatId: chatId, replyTo: null });
    // clear unread badge locally + server-side
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)),
    }));
    void api(`/api/chats/${chatId}/read`, { method: 'POST' }).catch(() => {});
    if (!get().messages[chatId]) {
      const data = await api<{ messages: MessageDTO[]; hasMore: boolean }>(
        `/api/chats/${chatId}/messages?limit=50`,
      );
      set((s) => ({
        messages: { ...s.messages, [chatId]: data.messages },
        hasMore: { ...s.hasMore, [chatId]: data.hasMore },
      }));
    }
  },

  async loadOlder(chatId) {
    const existing = get().messages[chatId] ?? [];
    const oldest = existing[0];
    if (!oldest) return;
    const data = await api<{ messages: MessageDTO[]; hasMore: boolean }>(
      `/api/chats/${chatId}/messages?limit=50&before=${encodeURIComponent(oldest.timestamp)}`,
    );
    set((s) => ({
      messages: { ...s.messages, [chatId]: [...data.messages, ...(s.messages[chatId] ?? [])] },
      hasMore: { ...s.hasMore, [chatId]: data.hasMore },
    }));
  },

  async sendMessage(input) {
    const chatId = get().activeChatId;
    if (!chatId) return;
    const replyTo = get().replyTo;
    set({ replyTo: null });
    // The server emits message:new over the socket; onNewMessage dedupes,
    // so we don't insert the response here to avoid double-adding.
    await api(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ ...input, quotedMessageId: replyTo?.id }),
    });
  },

  async retryMessage(chatId, messageId) {
    await api(`/api/chats/${chatId}/messages/${messageId}/retry`, { method: 'POST' });
  },

  setReplyTo(m) {
    set({ replyTo: m });
  },

  onNewMessage(m) {
    set((s) => {
      const list = s.messages[m.chatId];
      if (!list) return {}; // chat not loaded yet — chat:updated will refresh the sidebar
      if (list.some((x) => x.id === m.id)) return {};
      return { messages: { ...s.messages, [m.chatId]: [...list, m] } };
    });
  },

  onMessageUpdated(m) {
    set((s) => {
      const list = s.messages[m.chatId];
      if (!list) return {};
      return {
        messages: {
          ...s.messages,
          [m.chatId]: list.map((x) => (x.id === m.id ? m : x)),
        },
      };
    });
  },

  onMessageStatus({ chatId, messageId, status }) {
    set((s) => {
      const list = s.messages[chatId];
      if (!list) return {};
      return {
        messages: {
          ...s.messages,
          [chatId]: list.map((x) => (x.id === messageId ? { ...x, status } : x)),
        },
      };
    });
  },

  onChatUpdated(c) {
    set((s) => {
      const others = s.chats.filter((x) => x.id !== c.id);
      // keep local unread at 0 for the chat the user is looking at
      const unread = s.activeChatId === c.id ? 0 : c.unreadCount;
      return { chats: sortChats([...others, { ...c, unreadCount: unread }]) };
    });
  },

  setWaStatus(s) {
    set({ waStatus: s });
  },
}));
