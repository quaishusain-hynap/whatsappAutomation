import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/authStore.ts';
import { useChatStore } from './stores/chatStore.ts';
import { connectSocket, disconnectSocket } from './api/socket.ts';
import { api } from './api/client.ts';
import LoginPage from './features/login/LoginPage.tsx';
import ConnectPage from './features/connect/ConnectPage.tsx';
import ChatPage from './features/chat/ChatPage.tsx';
import UsersPage from './features/admin/UsersPage.tsx';
import type { WaStatusDTO } from '@mb/shared';

function NavBar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const waStatus = useChatStore((s) => s.waStatus);
  const location = useLocation();

  const tab = (to: string, label: string) => (
    <Link
      to={to}
      className={`rounded px-3 py-1.5 text-sm font-medium ${
        location.pathname === to ? 'bg-white/20 text-white' : 'text-white/80 hover:bg-white/10'
      }`}
    >
      {label}
    </Link>
  );

  const statusColor =
    waStatus?.status === 'connected'
      ? 'bg-green-400'
      : waStatus?.status === 'qr_pending' || waStatus?.status === 'connecting'
        ? 'bg-yellow-400'
        : 'bg-red-400';

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 bg-wa-teal-dark px-4">
      <span className="mr-2 font-semibold text-white">MB Travels</span>
      {tab('/', 'Chats')}
      {user?.role === 'admin' && tab('/connect', 'Connection')}
      {user?.role === 'admin' && tab('/admin/users', 'Users')}
      <div className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5 text-xs text-white/90">
          <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} />
          {waStatus?.status ?? 'unknown'}
        </span>
        <span className="text-sm text-white/90">{user?.displayName}</span>
        <button
          onClick={() => void logout()}
          className="rounded px-2 py-1 text-xs text-white/80 hover:bg-white/10"
        >
          Logout
        </button>
      </div>
    </header>
  );
}

export default function App() {
  const { user, booting, tryRefresh } = useAuthStore();

  useEffect(() => {
    void tryRefresh();
  }, [tryRefresh]);

  useEffect(() => {
    if (!user) {
      disconnectSocket();
      return;
    }
    connectSocket();
    // initial WA status snapshot (socket only pushes on change)
    void api<WaStatusDTO>('/api/wa/status')
      .then((s) => useChatStore.getState().setWaStatus(s))
      .catch(() => {});
  }, [user]);

  if (booting) {
    return <div className="flex h-full items-center justify-center text-gray-500">Loading…</div>;
  }

  if (!user) return <LoginPage />;

  return (
    <div className="flex h-full flex-col">
      <NavBar />
      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<ChatPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/admin/users" element={<UsersPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
