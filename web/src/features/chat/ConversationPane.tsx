import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '../../stores/chatStore.ts';
import { focusChat } from '../../api/socket.ts';
import MessageBubble from './MessageBubble.tsx';
import Composer from './Composer.tsx';
import type { MessageDTO } from '@mb/shared';

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
}

function withDaySeparators(messages: MessageDTO[]) {
  const out: Array<{ kind: 'day'; label: string; key: string } | { kind: 'msg'; msg: MessageDTO }> = [];
  let lastDay = '';
  for (const m of messages) {
    const day = new Date(m.timestamp).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      out.push({ kind: 'day', label: dayLabel(m.timestamp), key: `day-${day}` });
    }
    out.push({ kind: 'msg', msg: m });
  }
  return out;
}

export default function ConversationPane({ chatId }: { chatId: string }) {
  const chat = useChatStore((s) => s.chats.find((c) => c.id === chatId));
  const messages = useChatStore((s) => s.messages[chatId]);
  const hasMore = useChatStore((s) => s.hasMore[chatId]);
  const loadOlder = useChatStore((s) => s.loadOlder);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stickToBottom = useRef(true);
  const prevCount = useRef(0);

  useEffect(() => {
    focusChat(chatId);
  }, [chatId]);

  // Auto-scroll to bottom on first load and on new messages (if already at bottom)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !messages) return;
    const appended = messages.length > prevCount.current;
    prevCount.current = messages.length;
    if (stickToBottom.current && appended) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function onLoadOlder() {
    const el = scrollRef.current;
    if (!el) return;
    setLoadingOlder(true);
    const prevHeight = el.scrollHeight;
    await loadOlder(chatId);
    // keep viewport anchored after prepending
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - prevHeight;
      setLoadingOlder(false);
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200 bg-wa-panel px-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-300 text-white">
          {chat?.isGroup ? '👥' : (chat?.name ?? '?').replace('+', '').charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="text-[15px] font-medium text-gray-900">{chat?.name ?? '…'}</p>
          <p className="text-xs text-gray-500">{chat?.jid.split('@')[0]}</p>
        </div>
      </div>

      {/* messages */}
      <div ref={scrollRef} onScroll={onScroll} className="chat-bg min-h-0 flex-1 overflow-y-auto py-3">
        {hasMore && (
          <div className="mb-2 flex justify-center">
            <button
              onClick={() => void onLoadOlder()}
              disabled={loadingOlder}
              className="rounded-full bg-white px-4 py-1 text-xs text-gray-600 shadow hover:bg-gray-50 disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}
        {!messages && <p className="p-6 text-center text-sm text-gray-500">Loading messages…</p>}
        {messages &&
          withDaySeparators(messages).map((item) =>
            item.kind === 'day' ? (
              <div key={item.key} className="my-2 flex justify-center">
                <span className="rounded bg-white/90 px-3 py-1 text-xs text-gray-500 shadow-sm">
                  {item.label}
                </span>
              </div>
            ) : (
              <MessageBubble key={item.msg.id} m={item.msg} isGroup={chat?.isGroup ?? false} />
            ),
          )}
      </div>

      <Composer />
    </div>
  );
}
