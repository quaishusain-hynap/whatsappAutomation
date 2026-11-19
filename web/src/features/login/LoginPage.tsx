import { useState, type FormEvent } from 'react';
import { useAuthStore } from '../../stores/authStore.ts';

export default function LoginPage() {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-wa-panel">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-md">
        <h1 className="mb-1 text-xl font-semibold text-gray-800">MB Travels</h1>
        <p className="mb-6 text-sm text-gray-500">WhatsApp workspace — sign in</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <input
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-wa-teal"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-wa-teal"
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            disabled={busy || !username || !password}
            className="w-full rounded bg-wa-teal py-2 text-sm font-medium text-white hover:bg-wa-teal-dark disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
