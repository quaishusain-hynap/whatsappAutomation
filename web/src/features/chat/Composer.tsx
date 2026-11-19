import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { api } from '../../api/client.ts';
import { useChatStore } from '../../stores/chatStore.ts';
import type { MediaDTO } from '@mb/shared';

export default function Composer() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const replyTo = useChatStore((s) => s.replyTo);
  const setReplyTo = useChatStore((s) => s.setReplyTo);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<MediaDTO | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const data = await api<{ media: MediaDTO }>('/api/media', { method: 'POST', body: form });
      setAttachment(data.media);
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const trimmed = text.trim();
    if ((!trimmed && !attachment) || sending) return;
    setSending(true);
    try {
      await sendMessage({ text: trimmed || undefined, mediaId: attachment?.id });
      setText('');
      setAttachment(null);
    } catch (err) {
      alert(`Send failed: ${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="border-t border-gray-200 bg-wa-panel px-4 py-2.5">
      {replyTo && (
        <div className="mb-2 flex items-start justify-between rounded border-l-4 border-wa-teal bg-white px-3 py-1.5">
          <div className="text-xs text-gray-600">
            <p className="font-medium text-wa-teal-dark">
              Replying to {replyTo.direction === 'outbound' ? (replyTo.sentBy?.displayName ?? 'us') : 'customer'}
            </p>
            <p className="line-clamp-2">{replyTo.body || '[media]'}</p>
          </div>
          <button onClick={() => setReplyTo(null)} className="px-1 text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
      )}

      {attachment && (
        <div className="mb-2 flex items-center justify-between rounded bg-white px-3 py-1.5 text-sm text-gray-700">
          <span className="truncate">📎 {attachment.originalFilename ?? attachment.mimeType}</span>
          <button onClick={() => setAttachment(null)} className="px-1 text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input ref={fileRef} type="file" hidden onChange={(e) => void onPickFile(e)} />
        <button
          title="Attach"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="rounded-full p-2 text-xl text-gray-500 hover:bg-black/5 disabled:opacity-50"
        >
          {uploading ? '…' : '📎'}
        </button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message"
          rows={Math.min(5, Math.max(1, text.split('\n').length))}
          className="max-h-32 flex-1 resize-none rounded-lg bg-white px-3 py-2 text-sm outline-none"
        />
        <button
          onClick={() => void send()}
          disabled={sending || (!text.trim() && !attachment)}
          className="rounded-full bg-wa-teal p-2 px-3.5 text-white hover:bg-wa-teal-dark disabled:opacity-50"
          title="Send"
        >
          ➤
        </button>
      </div>
    </div>
  );
}
