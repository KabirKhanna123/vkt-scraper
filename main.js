// VKT StubHub Scraper v4
// Fetches raw HTML via BrightData Web Unlocker, then extracts prices
// directly from StubHub's embedded JSON (__NEXT_DATA__ / script tags).
// No browser rendering needed — same technique as VKT Pricer extension.

const { createClient } = require('@supabase/supabase-js');

const BRIGHTDATA_API_TOKEN = process.env.BRIGHTDATA_API_TOKEN || 'ac7d557e-67eb-4e04-90ef-56b1db829ab7';
const WEB_UNLOCKER_ZONE    = process.env.WEB_UNLOCKER_ZONE    || 'web_unlocker1';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API      = process.env.VKT_API      || 'https://vkt-volume-api.vercel.app';

const SCRAPE_DELAY_MS = parseInt(process.env.SCRAPE_DELAY_MS || '1500', 10);
const EVENT_LIMIT     = parseInt(process.env.EVENT_LIMIT     || '300',  10);
const CONCURRENCY     = parseInt(process.env.CONCURRENCY     || '8',    10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── TIER SCHEDULE ─────────────────────────────────────────────────────────────
const TIERS = {
  FIFA:         { label: 'FIFA',     recentHours: 22 },
  MAJOR_7D:     { label: 'DAILY',    recentHours: 22 },
  MAJOR_8_30D:  { label: 'EVERY_2D', recentHours: 46 },
  MAJOR_30PLUS: { label: 'EVERY_3D', recentHours: 70 },
};

function isFifa(event) {
  return !!(event.name && /world cup/i.test(event.name));
}

function daysUntil(dateStr) {
  if (!dateStr) return 999;
  const eventDate = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
}

function getEventTier(event) {
  if (isFifa(event))   return TIERS.FIFA;
  if (!event.is_major) return null;
  const days = daysUntil(event.date);
  if (days <= 7)       return TIERS.MAJOR_7D;
  if (days <= 30)      return TIERS.MAJOR_8_30D;
  return TIERS.MAJOR_30PLUS;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return sleep(min + Math.random() * (max - min)); }

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDateString(value) {
  if (!value) return null;
  const s = String(value).trim();
  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  return null;
}

function summarizePrices(prices) {
  const valid = (prices || [])
    .map(safeNum)
    .filter(v => v >= MIN_PRICE && v <= MAX_PRICE)
    .sort((a, b) => a - b);
  if (!valid.length) return { floor: null, avg: null, ceiling: null };
  return {
    floor:   Math.round(valid[0]),
    avg:     Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length - 1])
  };
}

// ── Core: extract all data from raw HTML ──────────────────────────────────────
// Same approach as VKT Pricer (content.js scrapeStubHubFromScripts).
// StubHub embeds complete listing data as JSON in <script> tags.
// We parse it directly from the HTML string — no browser needed.

function extractFromRawHtml(html, eventId) {
  const prices    = [];
  let name        = null;
  let date        = null;
  let venue       = null;
  let totalListings = 0;

  // ── 1. Extract from embedded JSON (window.__NEXT_DATA__ and similar) ──────
  // Find all <script> blocks that contain price-related fields
  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const match of scriptMatches) {
    const text = match[1] || '';
    if (!text.includes('"price"') &&
        !text.includes('"currentPrice"') &&
        !text.includes('"listingPrice"') &&
        !text.includes('"sellerAllInPrice"')) continue;
    if (text.length < 200) continue;

    let json = null;

    // Strategy A: window.__NEXT_DATA__
    const nextMatch = text.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>|$)/);
    if (nextMatch) {
      try { json = JSON.parse(nextMatch[1]); } catch (_) {}
    }

    // Strategy B: any large JSON blob in the script tag
    if (!json) {
      const blobs = [...text.matchAll(/(\{[\s\S]{200,}\})/g)];
      for (const blob of blobs) {
        try { json = JSON.parse(blob[1]); break; } catch (_) {}
      }
    }

    if (!json) continue;

    // Recursively walk JSON to find listing objects with prices
    function walk(obj, depth) {
      if (depth > 12 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(item => walk(item, depth + 1));
        return;
      }
      const raw = obj.currentPrice ?? obj.price ?? obj.listingPrice ?? obj.sellerAllInPrice;
      if (raw !== undefined) {
        const v = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) {
          prices.push(v);
        }
      }
      Object.values(obj).forEach(val => walk(val, depth + 1));
    }

    walk(json, 0);
    if (prices.length > 0) break; // found prices — stop scanning scripts
  }

  // ── 2. Extract event metadata from JSON-LD ────────────────────────────────
  const jsonLdMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of jsonLdMatches) {
    try {
      const items = [].concat(JSON.parse(match[1]));
      for (const item of items) {
        if (!item || (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent')) continue;
        if (!name && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
        if (!date && item.startDate) date = item.startDate;
        if (!venue && item.location?.name) {
          const city  = item.location.address?.addressLocality || '';
          const state = item.location.address?.addressRegion   || '';
          venue = [item.location.name, city, state].filter(Boolean).join(', ');
        }
        if (name && date && venue) break;
      }
    } catch (_) {}
    if (name && date && venue) break;
  }

  // ── 3. Extract listing count from raw text ────────────────────────────────
  const listingMatches = [...html.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(v => Number.isFinite(v) && v > 0);
  totalListings = listingMatches.length ? Math.max(...listingMatches) : prices.length;

  // ── 4. Fallback: regex price scan on raw HTML text ────────────────────────
  // Used when StubHub doesn't embed JSON (rare) — scan for $XXX patterns
  if (prices.length === 0) {
    const priceMatches = [...html.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)];
    for (const m of priceMatches) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) {
        prices.push(v);
      }
    }
  }

  // ── 5. Extract category floors (from aria-labels or JSON) ─────────────────
  const categories = [];
  const ariaMatches = [...html.matchAll(/aria-label="[^"]*?Category\s+(\d+)[^"]*?\$\s*([\d,]+)/gi)];
  for (const m of ariaMatches) {
    const catNum = parseInt(m[1], 10);
    const floor  = parseInt(m[2].replace(/,/g, ''), 10);
    if (catNum >= 1 && catNum <= 10 && floor >= MIN_PRICE && floor <= MAX_PRICE) {
      if (!categories.find(c => c.category === catNum)) {
        categories.push({ category: catNum, floor });
      }
    }
  }
  if (!categories.length) {
    const catMatches = [...html.matchAll(/"ticketClass(?:Name|Id)?"\s*:\s*"?(\d+)"?[^}]*?"minPrice"\s*:\s*([\d.]+)/gi)];
    for (const m of catMatches) {
      const catNum = parseInt(m[1], 10);
      const floor  = Math.round(parseFloat(m[2]));
      if (catNum >= 1 && catNum <= 4 && floor >= MIN_PRICE && floor <= MAX_PRICE) {
        if (!categories.find(c => c.category === catNum)) {
          categories.push({ category: catNum, floor });
        }
      }
    }
  }

  return { prices, name, date, venue, totalListings, categories };
}

// ── URL builders ──────────────────────────────────────────────────────────────

function buildStubHubUrl(event) {
  if (event.stubhub_url) {
    return event.stubhub_url.split('?')[0].replace(/\/$/, '') + '/?quantity=0';
  }
  const eventId = event.id;
  if (event.name && event.date) {
    try {
      const nameSlug = event.name
        .toLowerCase()
        .replace(/\s+at\s+/i, ' ')
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .replace(/\s+/g, '-');
      let citySlug = '';
      if (event.venue) {
        const vp = event.venue.split(',');
        if (vp.length >= 2) {
          citySlug = vp[1].trim().toLowerCase()
            .replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
        }
      }
      const d = new Date(event.date + 'T12:00:00');
      const dateSlug = `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
      const slug = citySlug
        ? `${nameSlug}-${citySlug}-tickets-${dateSlug}`
        : `${nameSlug}-tickets-${dateSlug}`;
      return `https://www.stubhub.com/${slug}/event/${eventId}/?quantity=0`;
    } catch (_) {}
  }
  return `https://www.stubhub.com/event/${eventId}/?quantity=0`;
}

function extractCanonicalUrl(html, eventId) {
  const og  = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)
           || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:url"/i);
  if (og  && og[1].includes(eventId)) return og[1].split('?')[0];
  const can = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)
            || html.match(/<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i);
  if (can && can[1].includes(eventId)) return can[1].split('?')[0];
  return null;
}

function isCorrectEventPage(html, eventId) {
  if (!html || html.length < 5000) return false;
  if (!html.includes(eventId)) return false;
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch && /Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(titleMatch[1])) return false;
  return true;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue,platform,is_major,stubhub_url')
    .not('id', 'like', 'tm_%')
    .not('name', 'ilike', '%football 2026 event%')
    .not('name', 'ilike', '%basketball 2026 event%')
    .not('name', 'ilike', '%baseball 2026 event%')
    .not('name', 'ilike', '%hockey 2026 event%')
    .not('name', 'ilike', '%soccer 2026 event%')
    .not('name', 'ilike', '% tickets')
    .not('name', 'ilike', '%2026 event')
    .order('date', { ascending: true })
    .limit(EVENT_LIMIT);
  if (error) { console.error('Failed to fetch events:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId, recentHours) {
  const since = new Date(Date.now() - recentHours * 3600000).toISOString();
  const { data } = await supabase
    .from('volume_snapshots')
    .select('id')
    .eq('event_id', eventId)
    .is('section', null)
    .gte('scraped_at', since)
    .limit(1);
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API + '/api/snapshot', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    if (!r.ok) { console.error('  Snapshot failed:', r.status); return false; }
    return true;
  } catch (e) { console.error('  Snapshot error:', e.message); return false; }
}

// ── BrightData fetch ──────────────────────────────────────────────────────────

async function fetchWithWebUnlocker(targetUrl) {
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + BRIGHTDATA_API_TOKEN,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        zone:    WEB_UNLOCKER_ZONE,
        url:     targetUrl,
        format:  'raw',
        headers: {
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      })
    });
    const text = await res.text();
    if (!res.ok) { console.error('  BrightData error:', res.status); return null; }
    try {
      const json = JSON.parse(text);
      return json.body || json.html || json.content || null;
    } catch (_) {}
    return text;
  } catch (e) {
    console.error('  Fetch error:', e.message);
    return null;
  }
}

// ── Worker ────────────────────────────────────────────────────────────────────
// Pure fetch + parse — no browser, no Playwright rendering.
// Processes events concurrently from the shared queue array.

async function worker(workerId, queue, results) {
  while (true) {
    const item = queue.shift();
    if (!item) break;

    const { event, tier } = item;
    const eventId  = event.id;
    const origName = event.name || 'Event ' + eventId;

    console.log(`[W${workerId}][${tier.label}] ${origName} (${eventId})`);

    try {
      // ── Fetch raw HTML via BrightData ────────────────────────────────────
      const url  = buildStubHubUrl(event);
      let html   = await fetchWithWebUnlocker(url);

      // Fallback to short URL if page doesn't contain our event ID
      if (!isCorrectEventPage(html, eventId)) {
        const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
        if (shortUrl !== url) html = await fetchWithWebUnlocker(shortUrl);
      }

      if (!isCorrectEventPage(html, eventId)) {
        console.log(`[W${workerId}] ✗ Wrong page for ${eventId}`);
        results.failed++;
        continue;
      }

      // ── Extract all data from raw HTML (no browser needed) ───────────────
      const extracted = extractFromRawHtml(html, eventId);
      const { prices, categories, totalListings } = extracted;

      let name  = extracted.name  || origName;
      if (name.toLowerCase().includes('tickets')) name = origName;
      const venue = extracted.venue || event.venue || null;
      const date  = normalizeDateString(extracted.date) || event.date || null;

      const summary = summarizePrices(prices);

      if (!summary.floor) {
        console.log(`[W${workerId}] ✗ No pricing for ${name} (${prices.length} raw prices found)`);
        results.failed++;
        continue;
      }

      console.log(`[W${workerId}] ✓ ${name} | ${totalListings} listings, floor $${summary.floor}, avg $${summary.avg}, ceiling $${summary.ceiling}${categories.length ? ' | cats: ' + categories.map(c => `Cat${c.category}=$${c.floor}`).join(' ') : ''}`);

      // ── Post event-level snapshot ─────────────────────────────────────────
      await postSnapshot({
        eventId, eventName: name, eventDate: date, venue,
        platform: 'StubHub',
        totalListings,
        section: null, sectionListings: 0,
        eventFloor:   summary.floor,
        eventAvg:     summary.avg,
        eventCeiling: summary.ceiling,
        source: 'brightdata'
      });

      // ── Post category-level snapshots ─────────────────────────────────────
      for (const cat of categories) {
        await postSnapshot({
          eventId, eventName: name, eventDate: date, venue,
          platform: 'StubHub',
          totalListings: 0,
          section:         `Category ${cat.category}`,
          sectionListings: 0,
          sectionFloor:    cat.floor,
          sectionAvg:      null,
          sectionCeiling:  summary.ceiling,
          eventFloor:      null,
          source: 'brightdata'
        });
      }

      // ── Update stale event metadata in Supabase ───────────────────────────
      const canonicalUrl = extractCanonicalUrl(html, eventId);
      const updates = {};
      if (name !== origName)                                  updates.name        = name;
      if (venue && venue !== event.venue)                     updates.venue       = venue;
      if (date  && date  !== event.date)                      updates.date        = date;
      if (canonicalUrl && canonicalUrl !== event.stubhub_url) updates.stubhub_url = canonicalUrl;
      if (Object.keys(updates).length) {
        await supabase.from('events').update(updates).eq('id', eventId);
      }

      results.scraped++;

    } catch (e) {
      console.error(`[W${workerId}] Error on ${eventId}:`, e.message);
      results.failed++;
    }

    await randomDelay(SCRAPE_DELAY_MS, SCRAPE_DELAY_MS + 1000);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`VKT scraper v4 — concurrency: ${CONCURRENCY}`);

  const manualId = process.argv[2];

  if (manualId) {
    // Manual single-event test run
    const queue   = [{ event: { id: manualId, name: 'Manual', date: null, venue: null, stubhub_url: null, is_major: true }, tier: TIERS.FIFA }];
    const results = { scraped: 0, failed: 0 };
    await worker(1, queue, results);
    console.log(`Done — scraped: ${results.scraped}, failed: ${results.failed}`);
    return;
  }

  // ── 1. Fetch events from Supabase ─────────────────────────────────────────
  const allEvents = await getEvents();

  // ── 2. Assign tiers ───────────────────────────────────────────────────────
  const tierCounts = { FIFA: 0, DAILY: 0, EVERY_2D: 0, EVERY_3D: 0, SKIPPED: 0 };

  const tieredEvents = allEvents
    .filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i)
    .map(event => {
      const tier = getEventTier(event);
      if (!tier) { tierCounts.SKIPPED++; return null; }
      return { event, tier };
    })
    .filter(Boolean);

  tieredEvents.forEach(({ tier }) => {
    if      (tier.label === 'FIFA')     tierCounts.FIFA++;
    else if (tier.label === 'DAILY')    tierCounts.DAILY++;
    else if (tier.label === 'EVERY_2D') tierCounts.EVERY_2D++;
    else if (tier.label === 'EVERY_3D') tierCounts.EVERY_3D++;
  });

  console.log(`Tier breakdown — FIFA: ${tierCounts.FIFA} | Daily: ${tierCounts.DAILY} | Every 2d: ${tierCounts.EVERY_2D} | Every 3d: ${tierCounts.EVERY_3D} | Skipped: ${tierCounts.SKIPPED}`);

  // ── 3. Filter recently scraped ────────────────────────────────────────────
  const recentFlags = await Promise.all(
    tieredEvents.map(({ event, tier }) => scrapedRecently(event.id, tier.recentHours))
  );

  const queue = tieredEvents.filter((_, i) => !recentFlags[i]);
  const skippedRecent = tieredEvents.length - queue.length;
  console.log(`Skipping ${skippedRecent} recently scraped — ${queue.length} events to process`);

  const runCounts = { FIFA: 0, DAILY: 0, EVERY_2D: 0, EVERY_3D: 0 };
  queue.forEach(({ tier }) => {
    if      (tier.label === 'FIFA')     runCounts.FIFA++;
    else if (tier.label === 'DAILY')    runCounts.DAILY++;
    else if (tier.label === 'EVERY_2D') runCounts.EVERY_2D++;
    else if (tier.label === 'EVERY_3D') runCounts.EVERY_3D++;
  });
  console.log(`This run — FIFA: ${runCounts.FIFA} | Daily: ${runCounts.DAILY} | Every 2d: ${runCounts.EVERY_2D} | Every 3d: ${runCounts.EVERY_3D}`);

  if (!queue.length) { console.log('Nothing to scrape.'); return; }

  // ── 4. Run workers concurrently ───────────────────────────────────────────
  const results     = { scraped: 0, failed: 0 };
  const workerCount = Math.min(CONCURRENCY, queue.length);
  console.log(`Launching ${workerCount} workers...`);

  await Promise.all(
    Array.from({ length: workerCount }, (_, i) => worker(i + 1, queue, results))
  );

  console.log(`\nDone — scraped: ${results.scraped}, failed: ${results.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
