// functions/api/board.js
// Cloudflare Pages Function — replaces the Express /api/board endpoint

const DEFAULT_COURTS = '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,21,22';
const DEFAULT_CACHE_TTL = 8; // seconds

// ── helpers (identical to server.js) ──────────────────────────────

const stripHtml = (raw = '') => raw.replace(/<[^>]*>/g, '').trim();

const parseCurrentItem = (val) => {
  if (val == null) return null;
  const n = parseInt(String(val).trim(), 10);
  return Number.isFinite(n) ? n : null;
};

function parseSequence(message = '') {
  const upper = message
    .toUpperCase()
    .replace(/COURT WILL SIT AT[^\n]*/g, ' ')
    .replace(
      /SEQUENCE|WOULD BE|ITEM NOS?\.?|ITEMS?\.?|PASS ?OVER IF ANY|THEREAFTER|THEN|AND|FRESH ?PASSOVER|FRESH/g,
      ' '
    )
    .replace(/[,:.;@()\[\]{}|/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!upper) return [];

  const tokens = upper.split(' ');
  const out = [];
  const isNum = (x) => !!x && /^\d+$/.test(x);

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i],
      b = tokens[i + 1],
      c = tokens[i + 2];

    if (isNum(a) && b === 'ONWARDS') {
      const start = +a;
      const cap = start + 500; // reasonable cap; avoids massive arrays
      for (let v = start; v <= cap; v++) out.push(v);
      i += 1;
      continue;
    }
    if (isNum(a) && b === 'TO' && isNum(c)) {
      const start = +a,
        end = +c,
        step = start <= end ? 1 : -1;
      for (let v = start; v !== end + step; v += step) out.push(v);
      i += 2;
    } else if (isNum(a)) {
      out.push(+a);
    }
  }

  const seen = new Set();
  return out.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
}

function buildTicker(upstream, courtsMap) {
  const ts = upstream?.now_2 || upstream?.now || '';
  const parts = [`Sequence — ${ts}`];
  for (const id of Object.keys(courtsMap)) {
    const row = courtsMap[id];
    if (!row) continue;
    const msg = (row.sequenceText || row.status || '').trim();
    if (msg) parts.push(`Court C${id}: ${msg}`);
  }
  return parts.join('  |  ');
}

function normalize(upstream) {
  const courts = {};
  const list = upstream?.listedItemDetails || [];
  for (const row of list) {
    const rawNo = String(row.court_no);
    const id = rawNo === '21' ? 'RC1' : rawNo === '22' ? 'RC2' : rawNo;
    const current = parseCurrentItem(row.item_no);
    const seq = parseSequence(row.court_message || '');
    courts[id] = {
      courtId: id,
      name: stripHtml(row.court_name || ''),
      current,
      status: stripHtml(row.item_status || ''),
      sequenceText: stripHtml(row.court_message || ''),
      sequence: seq,
      registration: stripHtml(row.registration_number_display || ''),
      petitioner: stripHtml(row.petitioner_name || ''),
      respondent: stripHtml(row.respondent_name || ''),
    };
  }
  const tickerText = buildTicker(upstream, courts);
  return {
    updatedAt: upstream?.now || new Date().toISOString(),
    tickerText,
    courts,
  };
}

// ── Basic Auth check ──────────────────────────────────────────────

function checkAuth(request, env) {
  const user = env.AUTH_USER;
  const pass = env.AUTH_PASS;
  if (!user || !pass) return true; // no auth configured → open

  const hdr = request.headers.get('Authorization') || '';
  const [type, token] = hdr.split(' ');
  if (type === 'Basic' && token) {
    try {
      const decoded = atob(token);
      const idx = decoded.indexOf(':');
      if (idx < 0) return false;
      const u = decoded.slice(0, idx);
      const p = decoded.slice(idx + 1); // handles passwords containing ':'
      if (u === user && p === pass) return true;
    } catch {
      return false; // malformed base64 → reject, don't crash
    }
  }
  return false;
}

// ── Main handler ──────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, env } = context;

  // CORS headers (same-origin is fine, but helpful for debugging)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Auth gate
  if (!checkAuth(request, env)) {
    return new Response('Auth required', {
      status: 401,
      headers: {
        ...corsHeaders,
        'WWW-Authenticate': 'Basic realm="SC Alerts"',
      },
    });
  }

  try {
    const courtsCsv = env.COURTS_CSV || DEFAULT_COURTS;
    const cacheTtl = Number(env.CACHE_TTL_SECONDS) || DEFAULT_CACHE_TTL;
    const upstreamUrl = `https://cdb.sci.gov.in/index.php?courtListCsv=${courtsCsv}&request=display_full&requestType=ajax`;

    // ── Cloudflare Cache API (edge cache per-POP) ──
    const cache = caches.default;
    const cacheKey = new Request(new URL('/api/board', request.url).href, {
      method: 'GET',
    });

    let cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Fetch upstream
    const upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'SC-Noticeboard-CF/1.0' },
      cf: { cacheTtl: 0 }, // don't let CF transparently cache the upstream
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: 'Failed to fetch board' }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const json = await upstream.json();
    const normalized = normalize(json);

    const response = new Response(JSON.stringify(normalized), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${cacheTtl}`,
      },
    });

    // Store in edge cache (non-blocking)
    context.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  } catch (e) {
    console.error('board handler error:', e);
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
}
