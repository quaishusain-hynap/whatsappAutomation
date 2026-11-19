import { useAuthStore } from '../stores/authStore.ts';

/** Fetch wrapper: attaches the access token, retries once after a refresh on 401. */
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { ...options, headers, credentials: 'include' });

  if (res.status === 401 && !retried && !path.startsWith('/api/auth/')) {
    const refreshed = await useAuthStore.getState().tryRefresh();
    if (refreshed) return api<T>(path, options, true);
    useAuthStore.getState().clear();
    throw new ApiError(401, 'session expired');
  }

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch { /* not json */ }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function mediaUrl(mediaId: string): string {
  const token = useAuthStore.getState().accessToken ?? '';
  return `/api/media/${mediaId}?token=${encodeURIComponent(token)}`;
}
