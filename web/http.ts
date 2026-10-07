export class ApiError extends Error {
  constructor(message: string, public status: number, public reauthenticate = false, public jsonResponse = false) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A request is sent exactly once. In particular, an uncertain write is never replayed here. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    text = await response.text();
  } catch {
    throw new ApiError('通信を確認できませんでした。接続を確認して、もう一度お試しください。', 0);
  }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch {
    const reauthenticate = response.status === 401 || response.status === 403 || response.redirected;
    throw new ApiError(reauthenticate
      ? '認証を確認できませんでした。ログインを確認してから、もう一度お試しください。'
      : `サーバーから正しい応答を受け取れませんでした${response.ok ? '' : `（HTTP ${response.status}）`}。もう一度お試しください。`,
    response.status, reauthenticate);
  }
  if (!response.ok) {
    // Only the API's structured error contract confirms a rejection. A gateway may
    // return valid JSON too; its status alone must not discard an uncertain write.
    const serverError = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error.trim() : '';
    throw new ApiError(serverError || '通信に失敗しました。', response.status, response.status === 401, !!serverError);
  }
  return data as T;
}
