/** Remove the local login token before any requests or dashboard rendering. */
export function takeLoginToken(location, history) {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token') || '';
  if (fragment.has('token')) history.replaceState(null, '', location.pathname + location.search);
  return token;
}

export async function api(path, {method = 'GET', body, fetcher = globalThis.fetch} = {}) {
  const response = await fetcher(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
