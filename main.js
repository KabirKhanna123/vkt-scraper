// VKT StubHub Scraper — Hybrid Mode
// Regular events: BrightData raw HTML + embedded JSON extraction (fast + cheap)
// FIFA events:    Live Playwright browser + network interception (full listing depth)

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

chromium.use(StealthPlugin());

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
  FIFA:         { label: 'FIFA',     recentHours: 22, mode: 'full'  },
  MAJOR_7D:     { label: 'DAILY',    recentHours: 22, mode: 'cheap' },
  MAJOR_8_30D:  { label: 'EVERY_2D', recentHours: 46, mode: 'cheap' },
  MAJOR_30PLUS: { label: 'EVERY_3D', recentHours: 70, mode: 'cheap' },
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return sleep(min + Math.random() * (max - min)); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

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
  const valid = (prices || []).map(safeNum)
    .filter(v => v >= MIN_PRICE && v <= MAX_PRICE)
    .sort((a, b) => a - b);
  if (!valid.length) return { floor: null, avg: null, ceiling: null };
  return {
    floor:   Math.round(valid[0]),
    avg:     Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length - 1])
  };
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildStubHubUrl(event) {
  if (event.stubhub_url) {
    return event.stubhub_url.split('?')[0].replace(/\/$/, '') + '/?quantity=0';
  }
  const eventId = event.id;
  if (event.name && event.date) {
    try {
      const nameSlug = event.name.toLowerCase()
        .replace(/\s+at\s+/i, ' ').replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
      let citySlug = '';
      if (event.venue) {
        const vp = event.venue.split(',');
        if (vp.length >= 2) citySlug = vp[1].trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
      }
      const d = new Date(event.date + 'T12:00:00');
      const dateSlug = `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
      const slug = citySlug ? `${nameSlug}-${citySlug}-tickets-${dateSlug}` : `${nameSlug}-tickets-${dateSlug}`;
      return `https://www.stubhub.com/${slug}/event/${eventId}/?quantity=0`;
    } catch (_) {}
  }
  return `https://www.stubhub.com/event/${eventId}/?quantity=0`;
}

function extractCanonicalUrl(html, eventId) {
  const og  = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i) ||
              html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:url"/i);
  if (og  && og[1].includes(eventId))  return og[1].split('?')[0];
  const can = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) ||
              html.match(/<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i);
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

// ── BrightData fetch (cheap mode) ─────────────────────────────────────────────

async function fetchWithWebUnlocker(targetUrl) {
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + BRIGHTDATA_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        zone: WEB_UNLOCKER_ZONE, url: targetUrl, format: 'raw',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      })
    });
    const text = await res.text();
    if (!res.ok) { console.error('  BrightData error:', res.status); return null; }
    try { const j = JSON.parse(text); return j.body || j.html || j.content || null; } catch (_) {}
    return text;
  } catch (e) { console.error('  Fetch error:', e.message); return null; }
}

// ── CHEAP MODE: extract prices from raw HTML embedded JSON ────────────────────
// Same as v4/v6 — fast, no browser rendering needed.

function extractFromRawHtml(html) {
  const prices    = [];
  let name        = null;
  let date        = null;
  let venue       = null;
  let totalListings = 0;
  const categories  = [];

  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = match[1] || '';
    if (text.length < 200) continue;
    if (!text.includes('"price"') && !text.includes('"currentPrice"') &&
        !text.includes('"listingPrice"') && !text.includes('"minPrice"') &&
        !text.includes('"sellerAllInPrice"')) continue;

    let json = null;
    const nextMatch = text.match(/window\.__NEXT_DATA__\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>|$)/);
    if (nextMatch) { try { json = JSON.parse(nextMatch[1]); } catch (_) {} }
    if (!json) {
      for (const blob of text.matchAll(/(\{[\s\S]{200,}\})/g)) {
        try { json = JSON.parse(blob[1]); break; } catch (_) {}
      }
    }
    if (!json) continue;

    (function walk(obj, depth) {
      if (depth > 15 || !obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(i => walk(i, depth + 1)); return; }

      // Category floor detection
      const labelVal = obj.categoryName ?? obj.seatCategory ?? obj.ticketClassName ??
                       obj.zoneName ?? obj.zone ?? obj.label;
      const floorVal = obj.minPrice ?? obj.floorPrice ?? obj.cheapestPrice ??
                       obj.lowestPrice ?? obj.startingPrice;
      if (labelVal && floorVal !== undefined) {
        const label = String(labelVal).trim();
        const floor = parseFloat(String(floorVal).replace(/[^0-9.]/g, ''));
        if (label && /categ|zone|hospitality|lower|upper|floor|pitch|field|club/i.test(label) &&
            Number.isFinite(floor) && floor >= MIN_PRICE && floor <= MAX_PRICE) {
          if (!categories.find(c => c.name === label)) categories.push({ name: label, floor: Math.round(floor) });
        }
      }
      const catId = obj.ticketClassId ?? obj.categoryId ?? obj.seatTypeId;
      if (catId !== undefined && floorVal !== undefined) {
        const num   = parseInt(String(catId), 10);
        const floor = parseFloat(String(floorVal).replace(/[^0-9.]/g, ''));
        if (num >= 1 && num <= 10 && Number.isFinite(floor) && floor >= MIN_PRICE && floor <= MAX_PRICE) {
          const catName = `Category ${num}`;
          if (!categories.find(c => c.name === catName)) categories.push({ name: catName, floor: Math.round(floor) });
        }
      }

      // Listing prices
      const raw = obj.currentPrice ?? obj.price ?? obj.listingPrice ?? obj.sellerAllInPrice;
      if (raw !== undefined) {
        const v = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) prices.push(v);
      }
      Object.values(obj).forEach(k => walk(k, depth + 1));
    })(json, 0);

    if (prices.length > 0) break;
  }

  // JSON-LD metadata
  for (const match of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      for (const item of [].concat(JSON.parse(match[1]))) {
        if (!item || (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent')) continue;
        if (!name  && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
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

  const listingNums = [...html.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
    .map(m => parseInt(m[1].replace(/,/g, ''), 10)).filter(v => Number.isFinite(v) && v > 0);
  totalListings = listingNums.length ? Math.max(...listingNums) : prices.length;

  if (prices.length === 0) {
    for (const m of html.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) prices.push(v);
    }
  }

  return { prices, name, date, venue, totalListings, categories };
}

// ── FULL MODE: live browser + network interception ────────────────────────────
// Used for FIFA events. Navigates directly to StubHub with JS enabled,
// intercepts all XHR/fetch responses that contain listing data,
// collects ALL listings including dynamically loaded batches.

async function scrapeWithFullBrowser(eventId, url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--no-first-run', '--no-zygote', '--disable-gpu']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Block heavy assets — keep JS and XHR alive
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    return route.continue();
  });

  const allPrices     = [];
  const categoryMap   = {}; // sectionName -> [prices]
  let   totalListings = 0;
  let   name          = null;
  let   date          = null;
  let   venue         = null;

  // ── Intercept every XHR/fetch response StubHub makes ─────────────────────
  page.on('response', async response => {
    try {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';

      // Only process JSON responses
      if (!ct.includes('json')) return;

      // Focus on StubHub's listing/inventory endpoints
      const isListingEndpoint =
        url.includes('/listings') ||
        url.includes('/inventory') ||
        url.includes('/tickets') ||
        url.includes('/event/') ||
        url.includes('stubhub.com/api');

      if (!isListingEndpoint) return;

      const text = await response.text().catch(() => '');
      if (!text || text.length < 100) return;

      let data;
      try { data = JSON.parse(text); } catch (_) { return; }

      // Walk the response and extract prices + section data
      (function extract(obj, depth) {
        if (depth > 10 || !obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(i => extract(i, depth + 1)); return; }

        // Total listing count
        if (obj.totalListings) totalListings = Math.max(totalListings, obj.totalListings);
        if (obj.numFound)      totalListings = Math.max(totalListings, obj.numFound);
        if (obj.total)         totalListings = Math.max(totalListings, obj.total);
        if (obj.count)         totalListings = Math.max(totalListings, obj.count);

        // Individual listing price
        const raw = obj.currentPrice?.amount ?? obj.currentPrice ??
                    obj.price?.amount ?? obj.price ??
                    obj.listingPrice ?? obj.sellerAllInPrice ??
                    obj.buyerPrice?.amount ?? obj.pricePerTicket;

        if (raw !== undefined) {
          const v = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
          if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) {
            allPrices.push(v);
            // Track by section
            const section = obj.section || obj.sectionName || obj.category || obj.categoryName || '';
            if (section) {
              const key = String(section).trim();
              if (!categoryMap[key]) categoryMap[key] = [];
              categoryMap[key].push(v);
            }
          }
        }

        Object.values(obj).forEach(val => extract(val, depth + 1));
      })(data, 0);

    } catch (_) {}
  });

  try {
    // Navigate with JS enabled — StubHub will fire all its API calls
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    // Extra wait for lazy-loaded listing batches
    await page.waitForTimeout(3000);

    // Also scroll to trigger any lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    // Get metadata from the rendered page
    const meta = await page.evaluate(() => {
      let name = null, date = null, venue = null;
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          for (const item of [].concat(JSON.parse(s.textContent))) {
            if (!item || (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent')) continue;
            if (!name  && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
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
      const listingNums = [...(document.body?.innerText || '').matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
        .map(m => parseInt(m[1].replace(/,/g,''), 10)).filter(v => v > 0);
      const total = listingNums.length ? Math.max(...listingNums) : 0;
      return { name, date, venue, total };
    });

    if (meta.name)  name  = meta.name;
    if (meta.date)  date  = meta.date;
    if (meta.venue) venue = meta.venue;
    if (meta.total) totalListings = Math.max(totalListings, meta.total);

  } catch (e) {
    console.error('  Full browser error:', e.message);
  } finally {
    await browser.close();
  }

  // Build category floors from intercepted section data
  const categories = [];
  for (const [section, sectionPrices] of Object.entries(categoryMap)) {
    const floor = Math.min(...sectionPrices);
    if (floor >= MIN_PRICE && floor <= MAX_PRICE) {
      // Only store meaningful category-style names
      if (/categ|cat\s*\d|zone|hospitality|lower|upper|field|pitch|club/i.test(section)) {
        categories.push({ name: section, floor: Math.round(floor) });
      }
    }
  }

  return { prices: allPrices, name, date, venue, totalListings, categories };
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
    .from('volume_snapshots').select('id')
    .eq('event_id', eventId).is('section', null).gte('scraped_at', since).limit(1);
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API + '/api/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
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

    console.log(`[W${workerId}][${tier.label}][${tier.mode}] ${origName} (${eventId})`);

    try {
      let extracted = null;
      const url = buildStubHubUrl(event);

      if (tier.mode === 'full') {
        // ── FIFA: full browser with network interception ──────────────────
        extracted = await scrapeWithFullBrowser(eventId, url);
        if (!extracted.prices.length) {
          // Fall back to short URL
          extracted = await scrapeWithFullBrowser(eventId, `https://www.stubhub.com/event/${eventId}/?quantity=0`);
        }
      } else {
        // ── Regular events: cheap BrightData HTML fetch ───────────────────
        let html = await fetchWithWebUnlocker(url);
        if (!isCorrectEventPage(html, eventId)) {
          const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
          if (shortUrl !== url) html = await fetchWithWebUnlocker(shortUrl);
        }
        if (!isCorrectEventPage(html, eventId)) {
          console.log(`[W${workerId}] ✗ Wrong page for ${eventId}`);
          results.failed++;
          continue;
        }
        extracted = extractFromRawHtml(html);
        // Update canonical URL for cheap mode
        extracted._html = html;
        extracted._eventId = eventId;
      }

      let name  = extracted.name || origName;
      if (name.toLowerCase().includes('tickets')) name = origName;
      const venue = extracted.venue || event.venue || null;
      const date  = normalizeDateString(extracted.date) || event.date || null;
      const { prices, totalListings, categories } = extracted;

      const summary = summarizePrices(prices);

      if (!summary.floor) {
        console.log(`[W${workerId}] ✗ No pricing for ${name}`);
        results.failed++;
        continue;
      }

      const catLog = categories.length
        ? ' | cats: ' + categories.slice(0, 4).map(c => `${c.name}=$${c.floor}`).join(', ')
        : '';

      console.log(`[W${workerId}] ✓ ${name} | ${totalListings} total, ${prices.length} priced, floor $${summary.floor}, avg $${summary.avg}, ceiling $${summary.ceiling}${catLog}`);

      // Post event-level snapshot
      await postSnapshot({
        eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
        totalListings, section: null, sectionListings: 0,
        eventFloor: summary.floor, eventAvg: summary.avg, eventCeiling: summary.ceiling,
        source: 'brightdata'
      });

      // Post category snapshots
      for (const cat of categories) {
        await postSnapshot({
          eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
          totalListings: 0,
          section: cat.name, sectionListings: 0,
          sectionFloor: cat.floor, sectionAvg: null, sectionCeiling: summary.ceiling,
          eventFloor: null, source: 'brightdata'
        });
      }

      // Update stale metadata
      const canonicalUrl = extracted._html ? extractCanonicalUrl(extracted._html, eventId) : null;
      const updates = {};
      if (name !== origName)                                  updates.name        = name;
      if (venue && venue !== event.venue)                     updates.venue       = venue;
      if (date  && date  !== event.date)                      updates.date        = date;
      if (canonicalUrl && canonicalUrl !== event.stubhub_url) updates.stubhub_url = canonicalUrl;
      if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id', eventId);

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
  console.log(`VKT scraper hybrid — concurrency: ${CONCURRENCY}`);
  console.log('  FIFA events  → full browser + network interception');
  console.log('  Other events → BrightData raw HTML (fast + cheap)');

  const manualId = process.argv[2];
  if (manualId) {
    const queue = [{ event: { id: manualId, name: 'Manual', date: null, venue: null, stubhub_url: null, is_major: true }, tier: TIERS.FIFA }];
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
    }).filter(Boolean);

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
  console.log(`Skipping ${tieredEvents.length - queue.length} recently scraped — ${queue.length} events to process`);

  const runCounts = { FIFA: 0, DAILY: 0, EVERY_2D: 0, EVERY_3D: 0 };
  queue.forEach(({ tier }) => {
    if      (tier.label === 'FIFA')     runCounts.FIFA++;
    else if (tier.label === 'DAILY')    runCounts.DAILY++;
    else if (tier.label === 'EVERY_2D') runCounts.EVERY_2D++;
    else if (tier.label === 'EVERY_3D') runCounts.EVERY_3D++;
  });
  console.log(`This run — FIFA: ${runCounts.FIFA} (full browser) | Daily: ${runCounts.DAILY} | Every 2d: ${runCounts.EVERY_2D} | Every 3d: ${runCounts.EVERY_3D} (cheap HTML)`);

  if (!queue.length) { console.log('Nothing to scrape.'); return; }

  const results     = { scraped: 0, failed: 0 };
  const workerCount = Math.min(CONCURRENCY, queue.length);
  console.log(`Launching ${workerCount} workers...`);

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1, queue, results)));
  console.log(`\nDone — scraped: ${results.scraped}, failed: ${results.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
