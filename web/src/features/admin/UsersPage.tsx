import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api/client.ts';

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'agent';
  isActive: boolean;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'agent' as 'admin' | 'agent' });
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const data = await api<{ users: UserRow[] }>('/api/admin/users');
      setUsers(data.users);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify(form) });
      setForm({ username: '', displayName: '', password: '', role: 'agent' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(u: UserRow) {
    await api(`/api/admin/users/${u.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive: !u.isActive }),
    });
    await load();
  }

  async function resetPassword(u: UserRow) {
    const password = prompt(`New password for ${u.username} (min 6 chars):`);
    if (!password) return;
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ password }) });
      alert('Password updated.');
    } catch (err) {
      alert((err as Error).message);
    }
  }

  const input = 'w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-wa-teal';

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto p-6">
      <h1 className="mb-4 text-lg font-semibold text-gray-800">Staff users</h1>

      <div className="mb-6 rounded-lg bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-medium text-gray-700">Add user</h2>
        <form onSubmit={(e) => void createUser(e)} className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <input className={input} placeholder="Username" value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className={input} placeholder="Display name" value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <input className={input} placeholder="Password" type="password" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className={input} value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'agent' })}>
            <option value="agent">Agent</option>
            <option value="admin">Admin</option>
          </select>
          <button
            disabled={busy || !form.username || !form.displayName || !form.password}
            className="rounded bg-wa-teal px-4 py-2 text-sm font-medium text-white hover:bg-wa-teal-dark disabled:opacity-50"
          >
            Create
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <div className="overflow-hidden rounded-lg bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-wa-panel text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2.5">User</th>
              <th className="px-4 py-2.5">Username</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-gray-100">
                <td className="px-4 py-2.5 font-medium text-gray-800">{u.displayName}</td>
                <td className="px-4 py-2.5 text-gray-600">{u.username}</td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-2 py-0.5 text-xs ${u.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className={`rounded px-2 py-0.5 text-xs ${u.isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {u.isActive ? 'active' : 'disabled'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => void resetPassword(u)} className="mr-3 text-xs text-wa-teal-dark hover:underline">
                    Reset password
                  </button>
                  <button onClick={() => void toggleActive(u)} className="text-xs text-gray-500 hover:underline">
                    {u.isActive ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
