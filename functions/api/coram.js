// functions/api/coram.js
// Fetches bench composition (coram) from wdb.sci.gov.in

const WDB_BOARD = 'https://wdb.sci.gov.in/get_board.php?ptype=c';
const WDB_BASE  = 'https://wdb.sci.gov.in/';
const CORAM_CACHE_TTL = 300; // 5 minutes

// Pairs each detail link with the nearest court id (id="cl_N") before it, so a
// court with no link (not sitting) doesn't shift every later court by one.
export function extractCourtLinks(html) {
  const re = /id="cl_(\d+)"|<a\s+[^>]*href="(display_court_all_cases\.php\?[^"]+)"/gi;
  const courts = [];
  const seen = new Set();
  let court = null;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) { court = m[1]; continue; }
    if (court && !seen.has(court)) {
      seen.add(court);
      courts.push({ court, url: WDB_BASE + m[2] });
    }
  }
  return courts;
}

// Same ids as /api/board: registrar courts 21/22 are RC1/RC2.
const courtKey = (n) => (n === '21' ? 'RC1' : n === '22' ? 'RC2' : n);

export function parseCoramFromDetail(html) {
  const result = { coram: [] };

  // Extract all [Coram : ...] blocks
  const coramRe = /\[Coram\s*:\s*([^\]]+)\]/gi;
  let m;
  while ((m = coramRe.exec(html)) !== null) {
    const judges = m[1].trim();
    // Find the session type right after: [Whole Day] or [Time : X]
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const sessionMatch = after.match(/\[(Whole Day|Time\s*:\s*[^\]]+)\]/i);
    result.coram.push({
      judges,
      session: sessionMatch ? sessionMatch[1].trim() : null,
    });
  }

  // Also grab the court number from the page ("REGISTRAR COURT - 1" is not Court 1)
  const courtMatch = html.match(/(?<!REGISTRAR\s*)COURT\s*[-–—]\s*(\d+)/i);
  if (courtMatch) result.courtNumber = courtMatch[1];

  return result;
}

export async function onRequest(context) {
  const { request } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Check edge cache first
    const cache = caches.default;
    const cacheKey = new Request(new URL('/api/coram', request.url).href, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // Step 1: Fetch the board overview
    const boardRes = await fetch(WDB_BOARD, {
      method: 'POST',
      headers: {
        'User-Agent': 'SC-Alerts/1.0',
        'Referer': 'https://wdb.sci.gov.in/display_original.php',
      },
    });

    if (!boardRes.ok) {
      return new Response(JSON.stringify({ error: 'WDB board fetch failed' }), {
        status: 502, headers: corsHeaders,
      });
    }

    const boardHTML = await boardRes.text();
    const courtLinks = extractCourtLinks(boardHTML);

    if (!courtLinks.length) {
      return new Response(JSON.stringify({ error: 'No court links found', courts: {} }), {
        status: 200, headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=60' },
      });
    }

    // Step 2: Fetch all court detail pages in parallel
    const detailFetches = courtLinks.map(async (c) => {
      try {
        const res = await fetch(c.url, {
          headers: {
            'User-Agent': 'SC-Alerts/1.0',
            'Referer': 'https://wdb.sci.gov.in/display_original.php',
          },
        });
        if (!res.ok) return { court: c.court, coram: [] };
        const html = await res.text();
        const parsed = parseCoramFromDetail(html);
        return { court: c.court, ...parsed };
      } catch {
        return { court: c.court, coram: [] };
      }
    });

    const results = await Promise.all(detailFetches);

    // Build response object keyed by court number
    const courts = {};
    for (const r of results) {
      const id = courtKey(r.courtNumber || r.court);
      courts[id] = {
        coram: r.coram || [],
        // Flatten for simple display: primary bench
        primaryJudges: r.coram?.[0]?.judges || null,
        primarySession: r.coram?.[0]?.session || null,
      };
    }

    const body = JSON.stringify({
      updatedAt: new Date().toISOString(),
      courts,
    });

    const response = new Response(body, {
      headers: { ...corsHeaders, 'Cache-Control': `public, max-age=${CORAM_CACHE_TTL}` },
    });

    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;

  } catch (e) {
    console.error('coram handler error:', e);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500, headers: corsHeaders,
    });
  }
}