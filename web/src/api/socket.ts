import { io, type Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore.ts';
import { useChatStore } from '../stores/chatStore.ts';

let socket: Socket | null = null;

export function connectSocket() {
  if (socket) return socket;
  const token = useAuthStore.getState().accessToken;
  if (!token) return null;

  socket = io('/', { auth: { token }, transports: ['websocket', 'polling'] });

  const chat = () => useChatStore.getState();
  socket.on('message:new', (m) => chat().onNewMessage(m));
  socket.on('message:updated', (m) => chat().onMessageUpdated(m));
  socket.on('message:status', (p) => chat().onMessageStatus(p));
  socket.on('chat:updated', (c) => chat().onChatUpdated(c));
  socket.on('chat:merged', (p) => chat().onChatMerged(p));
  socket.on('wa:status', (s) => chat().setWaStatus(s));

  socket.on('connect_error', async (err) => {
    if (err.message === 'unauthorized') {
      const ok = await useAuthStore.getState().tryRefresh();
      if (ok && socket) {
        (socket.auth as { token?: string }).token = useAuthStore.getState().accessToken ?? undefined;
        socket.connect();
      }
    }
  });

  return socket;
}

export function focusChat(chatId: string) {
  socket?.emit('chat:focus', chatId);
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
}
