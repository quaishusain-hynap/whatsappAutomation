import { create } from 'zustand';
import type { LoginResponse, UserDTO } from '@mb/shared';

interface AuthState {
  user: UserDTO | null;
  accessToken: string | null;
  /** true until the initial silent-refresh attempt completes */
  booting: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  tryRefresh: () => Promise<boolean>;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  booting: true,

  async login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? 'login failed');
    }
    const data = (await res.json()) as LoginResponse;
    set({ user: data.user, accessToken: data.accessToken, booting: false });
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    set({ user: null, accessToken: null });
  },

  async tryRefresh() {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        set({ booting: false });
        return false;
      }
      const data = (await res.json()) as LoginResponse;
      set({ user: data.user, accessToken: data.accessToken, booting: false });
      return true;
    } catch {
      set({ booting: false });
      return false;
    }
  },

  clear() {
    set({ user: null, accessToken: null, booting: false });
  },
}));
