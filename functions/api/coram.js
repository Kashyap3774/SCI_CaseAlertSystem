// functions/api/coram.js
// Fetches bench composition (coram) from wdb.sci.gov.in

const WDB_BOARD = 'https://wdb.sci.gov.in/get_board.php?ptype=c';
const WDB_BASE  = 'https://wdb.sci.gov.in/';
const CORAM_CACHE_TTL = 300; // 5 minutes

function extractCourtLinks(html) {
  const courts = [];
  // Match: <a href="display_court_all_cases.php?TOKEN">
  // Court number is in nearby <td> — but simpler: get all detail links + court numbers from the rows
  const rowRe = /<tr[^>]*>\s*<td[^>]*>\s*<td[^>]*>[\s\S]*?<a\s+href="(display_court_all_cases\.php\?[^"]+)"[\s\S]*?<\/tr>/gi;
  
  // Simpler approach: extract all unique detail links and court numbers
  const linkRe = /<a\s+[^>]*href="(display_court_all_cases\.php\?[^"]+)"[^>]*>/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const url = m[1];
    if (!links.includes(url)) links.push(url);
  }

  // Court numbers: look for <td ... id="cl_X" — where X is court number
  const courtNums = [];
  const idRe = /id="cl_(\d+)"/gi;
  while ((m = idRe.exec(html)) !== null) {
    if (!courtNums.includes(m[1])) courtNums.push(m[1]);
  }

  // Each court link corresponds to a court number (in order)
  // Also try to get court number from the link's preceding <td>
  // Fallback: pair links with court numbers by order
  return courtNums.map((num, i) => ({
    court: num,
    url: links[i] ? WDB_BASE + links[i] : null,
  })).filter(c => c.url);
}

function parseCoramFromDetail(html) {
  const result = { coram: [], session: null };

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

  // Also grab the court number from the page
  const courtMatch = html.match(/COURT\s*[-–—]\s*(\d+)/i);
  if (courtMatch) result.courtNumber = courtMatch[1];

  return result;
}

export async function onRequest(context) {
  const { request, env } = context;

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
        if (!res.ok) return { court: c.court, coram: [], session: null };
        const html = await res.text();
        const parsed = parseCoramFromDetail(html);
        return { court: c.court, ...parsed };
      } catch {
        return { court: c.court, coram: [], session: null };
      }
    });

    const results = await Promise.all(detailFetches);

    // Build response object keyed by court number
    const courts = {};
    for (const r of results) {
      const id = r.courtNumber || r.court;
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