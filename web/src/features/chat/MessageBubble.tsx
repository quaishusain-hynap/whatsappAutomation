import { mediaUrl } from '../../api/client.ts';
import { useChatStore } from '../../stores/chatStore.ts';
import type { MessageDTO } from '@mb/shared';

function Ticks({ status }: { status: MessageDTO['status'] }) {
  if (status === 'pending') return <span className="text-gray-400">🕓</span>;
  if (status === 'failed') return <span className="text-red-500">!</span>;
  const double = status !== 'sent';
  const blue = status === 'read' || status === 'played';
  return (
    <span className={blue ? 'text-wa-blue' : 'text-gray-400'} style={{ letterSpacing: '-0.35em' }}>
      ✓{double ? '✓' : ''}&nbsp;
    </span>
  );
}

function MediaContent({ m }: { m: MessageDTO }) {
  if (!m.media) {
    if (m.type !== 'text') {
      return <p className="text-sm italic text-gray-400">[{m.type} — loading…]</p>;
    }
    return null;
  }
  const url = mediaUrl(m.media.id);
  if (m.type === 'image' || m.type === 'sticker') {
    return (
      <a href={url} target="_blank" rel="noreferrer">
        <img src={url} alt="" className="max-h-72 max-w-full rounded" loading="lazy" />
      </a>
    );
  }
  if (m.type === 'video') {
    return <video src={url} controls className="max-h-72 max-w-full rounded" preload="metadata" />;
  }
  if (m.type === 'audio') {
    return <audio src={url} controls className="w-60" preload="metadata" />;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded bg-black/5 px-3 py-2 text-sm text-gray-700 hover:bg-black/10"
    >
      📄 <span className="truncate">{m.media.originalFilename ?? 'Document'}</span>
      <span className="shrink-0 text-xs text-gray-400">
        {(m.media.sizeBytes / 1024).toFixed(0)} KB
      </span>
    </a>
  );
}

const SENDER_COLORS = [
  'text-emerald-600', 'text-blue-600', 'text-purple-600', 'text-rose-600',
  'text-amber-600', 'text-teal-600', 'text-indigo-600', 'text-orange-600',
];

function senderColor(jid: string): string {
  let h = 0;
  for (let i = 0; i < jid.length; i++) h = (h * 31 + jid.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(h) % SENDER_COLORS.length]!;
}

function senderLabel(m: MessageDTO): string {
  if (m.senderName) return m.senderName;
  const phone = m.senderJid?.split('@')[0]?.split(':')[0];
  return phone ? `+${phone}` : 'Unknown';
}

export default function MessageBubble({ m, isGroup = false }: { m: MessageDTO; isGroup?: boolean }) {
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const retryMessage = useChatStore((s) => s.retryMessage);
  const out = m.direction === 'outbound';

  return (
    <div className={`group flex ${out ? 'justify-end' : 'justify-start'} px-6 py-0.5`}>
      <div
        className={`relative max-w-[65%] rounded-lg px-2.5 py-1.5 shadow-sm ${
          out ? 'bg-wa-out' : 'bg-white'
        }`}
      >
        {/* staff attribution */}
        {out && (
          <p className="text-xs font-semibold text-wa-teal-dark">
            {m.sentBy ? m.sentBy.displayName : 'Phone'}
          </p>
        )}

        {/* group sender name/number */}
        {!out && isGroup && (
          <p className={`text-xs font-semibold ${senderColor(m.senderJid ?? '')}`}>
            {senderLabel(m)}
          </p>
        )}

        {m.quoted && (
          <div className="mb-1 rounded border-l-4 border-wa-teal bg-black/5 px-2 py-1 text-xs text-gray-600">
            <p className="line-clamp-2">{m.quoted.body || '[media]'}</p>
          </div>
        )}

        <MediaContent m={m} />
        {m.body && <p className="whitespace-pre-wrap break-words text-[14.5px] text-gray-900">{m.body}</p>}

        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-gray-400">
          <span>
            {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {out && <Ticks status={m.status} />}
        </div>

        {m.status === 'failed' && (
          <button
            onClick={() => void retryMessage(m.chatId, m.id)}
            className="mt-1 text-xs font-medium text-red-600 hover:underline"
          >
            Failed — tap to retry
          </button>
        )}

        {/* hover actions */}
        <button
          title="Reply"
          onClick={() => setReplyTo(m)}
          className="absolute -top-2 right-1 hidden rounded bg-white px-1.5 py-0.5 text-xs text-gray-500 shadow group-hover:block"
        >
          ↩
        </button>
      </div>
    </div>
  );
}
