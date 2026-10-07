import { afterEach, expect, test, vi } from 'vitest';
import { api, ApiError } from './http';

afterEach(() => vi.unstubAllGlobals());

test.each([
  { status: 502, text: '<html>Bad Gateway</html>', reauthenticate: false },
  { status: 200, text: '<html>Unexpected page</html>', reauthenticate: false },
  { status: 200, text: '', reauthenticate: false },
  { status: 401, text: 'Unauthorized', reauthenticate: true },
])('non-JSON status $status is a friendly API error with recovery metadata', async ({ status, text, reauthenticate }) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text, { status })));
  const error = await api('/api/overview').catch(error => error);
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) throw error;
  expect(error.status).toBe(status);
  expect(error.reauthenticate).toBe(reauthenticate);
  expect(error.message).not.toMatch(/JSON|Unexpected|<html>|Bad Gateway/);
  expect(error.message).toContain('もう一度');
});

test.each(['null', '"conflict"', '{"message":"Proxy conflict"}'])('an unrelated JSON error body %s does not confirm an API rejection', async text => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text, { status: 409 })));
  await expect(api('/api/review', { eventId: 'same-event' })).rejects.toMatchObject({ status: 409, jsonResponse: false });
});

test('an HTML login redirect requests reauthentication instead of exposing a parser error', async () => {
  const response = new Response('<html>Login</html>');
  Object.defineProperty(response, 'redirected', { value: true });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  await expect(api('/api/overview')).rejects.toMatchObject({ status: 200, reauthenticate: true });
});

test('JSON success, null progress and server errors keep their existing contracts', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response('{"imported":true,"decks":[]}'))
    .mockResolvedValueOnce(new Response('null'))
    .mockResolvedValueOnce(new Response('{"error":"ログインしてください。"}', { status: 401 }))
    .mockResolvedValueOnce(new Response('{"error":"変更の権限がありません。"}', { status: 403 })));
  await expect(api('/api/overview')).resolves.toEqual({ imported: true, decks: [] });
  await expect(api('/api/progress')).resolves.toBeNull();
  await expect(api('/api/review', { eventId: 'same-event' })).rejects.toMatchObject({ message: 'ログインしてください。', status: 401, reauthenticate: true, jsonResponse: true });
  await expect(api('/api/review', { eventId: 'same-event' })).rejects.toMatchObject({ message: '変更の権限がありません。', status: 403, reauthenticate: false });
});

test.each(['transport', 'non-JSON'])('an uncertain %s write is sent once and retains its payload for explicit retry', async failure => {
  const fetch = vi.fn();
  if (failure === 'transport') fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  else fetch.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }));
  fetch.mockResolvedValueOnce(new Response('{"ok":true}'));
  vi.stubGlobal('fetch', fetch);
  const pending = { eventId: 'pending-event', rating: 3 };
  await expect(api('/api/review', pending)).rejects.toBeInstanceOf(ApiError);
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(api('/api/review', pending)).resolves.toEqual({ ok: true });
  expect(fetch.mock.calls.map(call => call[1].body)).toEqual([JSON.stringify(pending), JSON.stringify(pending)]);
});
