// functions/_middleware.js
// Optional password protection for the whole site. Set both AUTH_USER and
// AUTH_PASS (Cloudflare dashboard → Settings → Variables) to turn it on.

// Not secret, and browsers fetch these without the saved password.
const isOpenPath = (path) =>
  path === '/healthz' ||
  path === '/manifest.webmanifest' ||
  path === '/sw.js' ||
  path.startsWith('/icons/');

function hasValidCredentials(request, user, pass) {
  const [type, token] = (request.headers.get('Authorization') || '').split(' ');
  if (type !== 'Basic' || !token) return false;
  try {
    const bytes = Uint8Array.from(atob(token), (ch) => ch.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes); // browsers send UTF-8
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    // Password may itself contain ':'
    return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass;
  } catch {
    return false; // malformed base64 → reject, don't crash
  }
}

export async function onRequest({ request, env, next }) {
  const user = env.AUTH_USER;
  const pass = env.AUTH_PASS;
  if (!user || !pass) return next(); // no password configured → open

  const { pathname } = new URL(request.url);
  if (request.method === 'OPTIONS' || isOpenPath(pathname)) return next();
  if (hasValidCredentials(request, user, pass)) return next();

  return new Response('Password required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SC Alerts", charset="UTF-8"' },
  });
}
