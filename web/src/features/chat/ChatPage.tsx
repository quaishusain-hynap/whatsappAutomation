import { useEffect, useState } from 'react';
import { useChatStore } from '../../stores/chatStore.ts';
import ConversationPane from './ConversationPane.tsx';
import type { ChatDTO } from '@mb/shared';

function timeLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function ChatListItem({ chat, active, onClick }: { chat: ChatDTO; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2.5 text-left hover:bg-gray-50 ${
        active ? 'bg-wa-panel' : 'bg-white'
      }`}
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-300 text-lg text-white">
        {chat.isGroup ? '👥' : chat.name.replace('+', '').charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-medium text-gray-900">{chat.name}</span>
          <span className={`shrink-0 text-xs ${chat.unreadCount ? 'font-semibold text-wa-teal' : 'text-gray-400'}`}>
            {timeLabel(chat.lastMessageAt)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-gray-500">{chat.lastMessagePreview ?? ''}</span>
          {chat.unreadCount > 0 && (
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-wa-teal px-1.5 text-xs font-semibold text-white">
              {chat.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export default function ChatPage() {
  const { chats, chatsLoaded, activeChatId, loadChats, openChat, waStatus } = useChatStore();
  const [search, setSearch] = useState('');

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  const filtered = search
    ? chats.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : chats;

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="flex w-[380px] shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="border-b border-gray-200 bg-wa-panel p-2.5">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search or start new chat"
            className="w-full rounded-lg bg-white px-3 py-1.5 text-sm outline-none"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!chatsLoaded && <p className="p-4 text-sm text-gray-400">Loading chats…</p>}
          {chatsLoaded && filtered.length === 0 && (
            <p className="p-4 text-sm text-gray-400">
              {waStatus?.status === 'connected'
                ? 'No chats yet — they appear as messages arrive.'
                : 'Connect WhatsApp to see your chats (admin → Connection tab).'}
            </p>
          )}
          {filtered.map((c) => (
            <ChatListItem
              key={c.id}
              chat={c}
              active={c.id === activeChatId}
              onClick={() => void openChat(c.id)}
            />
          ))}
        </div>
      </aside>

      {/* Conversation */}
      <section className="min-w-0 flex-1">
        {activeChatId ? (
          <ConversationPane key={activeChatId} chatId={activeChatId} />
        ) : (
          <div className="chat-bg flex h-full items-center justify-center">
            <div className="rounded-lg bg-white/80 px-8 py-6 text-center shadow-sm">
              <h2 className="text-lg font-medium text-gray-700">MB Travels WhatsApp</h2>
              <p className="mt-1 text-sm text-gray-500">Select a chat to start messaging.</p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
