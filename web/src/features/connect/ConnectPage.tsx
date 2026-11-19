import { useState } from 'react';
import { api } from '../../api/client.ts';
import { useAuthStore } from '../../stores/authStore.ts';
import { useChatStore } from '../../stores/chatStore.ts';
import type { WaStatusDTO } from '@mb/shared';

export default function ConnectPage() {
  const user = useAuthStore((s) => s.user);
  const waStatus = useChatStore((s) => s.waStatus);
  const setWaStatus = useChatStore((s) => s.setWaStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = user?.role === 'admin';
  const status = waStatus?.status ?? 'disconnected';

  async function call(path: string) {
    setBusy(true);
    setError(null);
    try {
      const s = await api<WaStatusDTO>(path, { method: 'POST' });
      setWaStatus(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-wa-panel">
      <div className="w-full max-w-md rounded-lg bg-white p-8 text-center shadow-md">
        <h1 className="mb-2 text-lg font-semibold text-gray-800">WhatsApp Connection</h1>
        <p className="mb-6 text-sm text-gray-500">
          Status: <span className="font-medium">{status}</span>
          {waStatus?.phoneNumber && <> · +{waStatus.phoneNumber}</>}
        </p>

        {status === 'qr_pending' && waStatus?.qrDataUrl && (
          <div className="mb-6">
            <img src={waStatus.qrDataUrl} alt="QR code" className="mx-auto h-64 w-64" />
            <p className="mt-3 text-sm text-gray-600">
              Open WhatsApp on the phone → <b>Linked devices</b> → <b>Link a device</b> and scan this
              code.
            </p>
          </div>
        )}

        {status === 'connected' && (
          <p className="mb-6 text-sm text-green-700">
            Connected. All incoming and outgoing messages are being recorded.
          </p>
        )}

        {status === 'logged_out' && (
          <p className="mb-6 text-sm text-amber-700">
            The session was logged out. Reconnect to pair again with a new QR code.
          </p>
        )}

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {isAdmin ? (
          <div className="flex justify-center gap-3">
            {(status === 'disconnected' || status === 'logged_out') && (
              <button
                disabled={busy}
                onClick={() => void call('/api/wa/connect')}
                className="rounded bg-wa-teal px-4 py-2 text-sm font-medium text-white hover:bg-wa-teal-dark disabled:opacity-50"
              >
                {busy ? 'Starting…' : 'Connect / Show QR'}
              </button>
            )}
            {(status === 'connected' || status === 'qr_pending' || status === 'connecting') && (
              <button
                disabled={busy}
                onClick={() => {
                  if (confirm('Unlink this WhatsApp session? You will need to scan the QR again.')) {
                    void call('/api/wa/logout');
                  }
                }}
                className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Unlink device
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Only an admin can manage the connection.</p>
        )}
      </div>
    </div>
  );
}
