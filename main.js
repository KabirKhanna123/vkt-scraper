// VKT StubHub Scraper v5
// Fixes:
// 1. Pagination — fetches ALL listings via StubHub's internal listing API
// 2. Category extraction — broader JSON walk to find category floor data
// 3. Better total listing count from API response

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
          'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
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

// ── Fetch all listings via StubHub's internal JSON API ─────────────────────────
// StubHub exposes a paginated listing endpoint that returns full listing data.
// This gives us ALL listings — not just the 10 embedded in __NEXT_DATA__.

async function fetchAllListings(eventId) {
  const allPrices = [];
  // Category map: section/category name -> array of prices
  const categoryPrices = {};
  let totalListings = 0;
  let page = 1;
  const perPage = 200;

  while (true) {
    const apiUrl = `https://www.stubhub.com/api/event/${eventId}/listings?quantity=0&rows=${perPage}&start=${(page - 1) * perPage}`;
    const html = await fetchWithWebUnlocker(apiUrl);
    if (!html) break;

    let data = null;
    try { data = JSON.parse(html); } catch (_) {}

    // StubHub may return HTML instead of JSON for some requests
    // In that case, fall back to extracting from whatever we got
    if (!data || typeof data !== 'object') {
      // Try extracting JSON from response text
      const jsonMatch = html.match(/\{[\s\S]{100,}\}/);
      if (jsonMatch) {
        try { data = JSON.parse(jsonMatch[0]); } catch (_) {}
      }
    }

    if (!data) break;

    // Extract total count
    if (data.totalListings) totalListings = Math.max(totalListings, data.totalListings);
    if (data.numFound)      totalListings = Math.max(totalListings, data.numFound);
    if (data.total)         totalListings = Math.max(totalListings, data.total);

    // Extract listings
    const listings = data.listing || data.listings || data.items || [];
    if (!Array.isArray(listings) || !listings.length) break;

    for (const l of listings) {
      // Price fields StubHub uses
      const price = l.currentPrice?.amount
        ?? l.buyerPrice?.amount
        ?? l.currentPrice
        ?? l.listingPrice
        ?? l.price
        ?? l.pricePerTicket;

      const v = parseFloat(String(price || '').replace(/[^0-9.]/g, ''));
      if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) {
        allPrices.push(v);

        // Track by section/category
        const section = l.section || l.sectionName || l.category || l.categoryName || '';
        if (section) {
          const key = String(section).trim();
          if (!categoryPrices[key]) categoryPrices[key] = [];
          categoryPrices[key].push(v);
        }
      }
    }

    // If we got fewer than a full page, we're done
    if (listings.length < perPage) break;
    // If we've scraped all listings, stop
    if (totalListings > 0 && allPrices.length >= totalListings) break;
    // Safety cap — don't scrape more than 2000 listings
    if (allPrices.length >= 2000) break;

    page++;
    await sleep(500); // small pause between pages
  }

  return { allPrices, categoryPrices, totalListings };
}

// ── Extract data from the event page HTML ─────────────────────────────────────
// Gets metadata (name, date, venue), listing count, and initial prices.
// Also extracts category floor data from embedded JSON.

function extractFromPageHtml(html) {
  let name  = null;
  let date  = null;
  let venue = null;
  let totalListings = 0;
  const prices     = [];
  const categories = [];

  // ── 1. Walk all script tags for embedded JSON ─────────────────────────────
  const scriptMatches = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const match of scriptMatches) {
    const text = match[1] || '';
    if (text.length < 200) continue;

    let json = null;

    // Try __NEXT_DATA__ first
    const nextMatch = text.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>|$)/);
    if (nextMatch) {
      try { json = JSON.parse(nextMatch[1]); } catch (_) {}
    }
    // Fallback: any large JSON blob
    if (!json && (text.includes('"price"') || text.includes('"currentPrice"') || text.includes('"minPrice"'))) {
      const blobs = [...text.matchAll(/(\{[\s\S]{200,}\})/g)];
      for (const blob of blobs) {
        try { json = JSON.parse(blob[1]); break; } catch (_) {}
      }
    }

    if (!json) continue;

    // ── Walk JSON for prices AND category data ─────────────────────────────
    function walk(obj, depth, parentKey) {
      if (depth > 15 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        obj.forEach(item => walk(item, depth + 1, parentKey));
        return;
      }

      const keys = Object.keys(obj);

      // Detect category-level price objects
      // StubHub uses keys like: categoryName, seatCategory, ticketClass, zone
      const catKey = obj.categoryName || obj.seatCategory || obj.ticketClassName
        || obj.zone || obj.section || obj.categoryLabel || obj.label;
      const minPriceRaw = obj.minPrice ?? obj.floorPrice ?? obj.cheapestPrice
        ?? obj.lowestPrice ?? obj.startingPrice;

      if (catKey && minPriceRaw !== undefined) {
        const catName = String(catKey).trim();
        const floor   = parseFloat(String(minPriceRaw).replace(/[^0-9.]/g, ''));
        if (catName && Number.isFinite(floor) && floor >= MIN_PRICE && floor <= MAX_PRICE) {
          if (!categories.find(c => c.name === catName)) {
            categories.push({ name: catName, floor: Math.round(floor) });
          }
        }
      }

      // Also detect numeric category IDs (Category 1, Category 2, etc.)
      const catId = obj.ticketClassId ?? obj.categoryId ?? obj.seatTypeId;
      if (catId !== undefined && minPriceRaw !== undefined) {
        const num   = parseInt(String(catId), 10);
        const floor = parseFloat(String(minPriceRaw).replace(/[^0-9.]/g, ''));
        if (num >= 1 && num <= 10 && Number.isFinite(floor) && floor >= MIN_PRICE && floor <= MAX_PRICE) {
          const catName = `Category ${num}`;
          if (!categories.find(c => c.name === catName)) {
            categories.push({ name: catName, floor: Math.round(floor) });
          }
        }
      }

      // Extract listing prices
      const raw = obj.currentPrice ?? obj.price ?? obj.listingPrice ?? obj.sellerAllInPrice;
      if (raw !== undefined) {
        const v = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) prices.push(v);
      }

      keys.forEach(k => walk(obj[k], depth + 1, k));
    }

    walk(json, 0, '');
  }

  // ── 2. Category floors from aria-label patterns in SVG map ───────────────
  // StubHub's venue map has aria-labels like "Category 1 from $500"
  const ariaPatterns = [
    /aria-label="[^"]*?(?:Category|Cat\.?)\s+(\d+)[^"]*?(?:from\s+)?\$\s*([\d,]+)/gi,
    /data-label="[^"]*?(?:Category|Cat\.?)\s+(\d+)[^"]*?(?:from\s+)?\$\s*([\d,]+)/gi,
    /"label"\s*:\s*"(?:Category|Cat\.?)\s+(\d+)[^"]*?"\s*[^}]*?"(?:minPrice|floor|price)"\s*:\s*([\d.]+)/gi,
  ];

  for (const pattern of ariaPatterns) {
    for (const m of html.matchAll(pattern)) {
      const catNum = parseInt(m[1], 10);
      const floor  = parseInt(m[2].replace(/,/g, ''), 10);
      const catName = `Category ${catNum}`;
      if (catNum >= 1 && catNum <= 10 && floor >= MIN_PRICE && floor <= MAX_PRICE) {
        if (!categories.find(c => c.name === catName)) {
          categories.push({ name: catName, floor });
        }
      }
    }
  }

  // ── 3. JSON-LD metadata ───────────────────────────────────────────────────
  for (const match of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const items = [].concat(JSON.parse(match[1]));
      for (const item of items) {
        if (!item || (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent')) continue;
        if (!name  && item.name      && !item.name.toLowerCase().includes('tickets')) name = item.name;
        if (!date  && item.startDate) date = item.startDate;
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

  // ── 4. Total listing count from page text ─────────────────────────────────
  const listingMatches = [...html.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(v => Number.isFinite(v) && v > 0);
  totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;

  // ── 5. Fallback: regex price scan ────────────────────────────────────────
  if (prices.length === 0) {
    for (const m of html.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) prices.push(v);
    }
  }

  return { name, date, venue, totalListings, prices, categories };
}

// ── URL helpers ───────────────────────────────────────────────────────────────

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
        .replace(/[^a-z0-9\s]/g, '').trim()
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
  if (og  && og[1].includes(eventId))  return og[1].split('?')[0];
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

// ── Worker ────────────────────────────────────────────────────────────────────

async function worker(workerId, queue, results) {
  while (true) {
    const item = queue.shift();
    if (!item) break;

    const { event, tier } = item;
    const eventId  = event.id;
    const origName = event.name || 'Event ' + eventId;

    console.log(`[W${workerId}][${tier.label}] ${origName} (${eventId})`);

    try {
      // ── Fetch event page HTML ─────────────────────────────────────────────
      const url = buildStubHubUrl(event);
      let html  = await fetchWithWebUnlocker(url);

      if (!isCorrectEventPage(html, eventId)) {
        const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
        if (shortUrl !== url) html = await fetchWithWebUnlocker(shortUrl);
      }

      if (!isCorrectEventPage(html, eventId)) {
        console.log(`[W${workerId}] ✗ Wrong page for ${eventId}`);
        results.failed++;
        continue;
      }

      // ── Extract metadata + initial prices + categories from HTML ──────────
      const pageData = extractFromPageHtml(html);
      let name  = pageData.name  || origName;
      if (name.toLowerCase().includes('tickets')) name = origName;
      const venue = pageData.venue || event.venue || null;
      const date  = normalizeDateString(pageData.date) || event.date || null;
      let categories = pageData.categories;

      // ── Fetch ALL listings via StubHub's listing API ──────────────────────
      // This gives us the full price distribution, not just the first 10.
      const listingData = await fetchAllListings(eventId);

      let allPrices    = listingData.allPrices;
      let totalListings = listingData.totalListings || pageData.totalListings;
      const categoryPrices = listingData.categoryPrices;

      // Fall back to page prices if API call yielded nothing
      if (allPrices.length === 0) allPrices = pageData.prices;
      if (totalListings === 0)     totalListings = allPrices.length;

      const summary = summarizePrices(allPrices);

      if (!summary.floor) {
        console.log(`[W${workerId}] ✗ No pricing for ${name}`);
        results.failed++;
        continue;
      }

      // ── Build category data ────────────────────────────────────────────────
      // From API section breakdown (if we got it)
      if (Object.keys(categoryPrices).length > 0 && categories.length === 0) {
        for (const [section, sectionPrices] of Object.entries(categoryPrices)) {
          const sFloor = Math.min(...sectionPrices);
          if (sFloor >= MIN_PRICE && sFloor <= MAX_PRICE) {
            categories.push({ name: section, floor: Math.round(sFloor) });
          }
        }
        // Keep only category-style sections (Category 1, Category 2, etc.)
        categories = categories.filter(c =>
          /^category\s*\d+$/i.test(c.name) ||
          /^cat\.?\s*\d+$/i.test(c.name)   ||
          /^hospitality/i.test(c.name)
        );
      }

      const catLog = categories.length
        ? ' | cats: ' + categories.map(c => `${c.name}=$${c.floor}`).join(', ')
        : '';

      console.log(`[W${workerId}] ✓ ${name} | ${totalListings} listings (${allPrices.length} priced), floor $${summary.floor}, avg $${summary.avg}, ceiling $${summary.ceiling}${catLog}`);

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
          section:         cat.name,
          sectionListings: 0,
          sectionFloor:    cat.floor,
          sectionAvg:      null,
          sectionCeiling:  summary.ceiling,
          eventFloor:      null,
          source: 'brightdata'
        });
      }

      // ── Update stale metadata in Supabase ─────────────────────────────────
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
  console.log(`VKT scraper v5 — concurrency: ${CONCURRENCY}`);

  const manualId = process.argv[2];

  if (manualId) {
    const queue   = [{ event: { id: manualId, name: 'Manual', date: null, venue: null, stubhub_url: null, is_major: true }, tier: TIERS.FIFA }];
    const results = { scraped: 0, failed: 0 };
    await worker(1, queue, results);
    console.log(`Done — scraped: ${results.scraped}, failed: ${results.failed}`);
    return;
  }

  const allEvents = await getEvents();

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

  const results     = { scraped: 0, failed: 0 };
  const workerCount = Math.min(CONCURRENCY, queue.length);
  console.log(`Launching ${workerCount} workers...`);

  await Promise.all(
    Array.from({ length: workerCount }, (_, i) => worker(i + 1, queue, results))
  );

  console.log(`\nDone — scraped: ${results.scraped}, failed: ${results.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
