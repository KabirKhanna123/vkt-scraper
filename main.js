// VKT StubHub Scraper — Full Browser Mode
// Uses live Playwright browser + network interception for ALL events.
// Captures every listing API response StubHub fires, giving complete data.

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { createClient } = require('@supabase/supabase-js');

chromium.use(StealthPlugin());

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API      = process.env.VKT_API      || 'https://vkt-volume-api.vercel.app';

const EVENT_LIMIT  = parseInt(process.env.EVENT_LIMIT  || '300', 10);
const CONCURRENCY  = parseInt(process.env.CONCURRENCY  || '4',   10); // lower — full browser is heavier
const MIN_PRICE    = 10;
const MAX_PRICE    = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── TIERS ─────────────────────────────────────────────────────────────────────
const TIERS = {
  FIFA:         { label: 'FIFA',     recentHours: 22 },
  MAJOR_7D:     { label: 'DAILY',    recentHours: 22 },
  MAJOR_8_30D:  { label: 'EVERY_2D', recentHours: 46 },
  MAJOR_30PLUS: { label: 'EVERY_3D', recentHours: 70 },
};

function isFifa(event)    { return !!(event.name && /world cup/i.test(event.name)); }
function sleep(ms)        { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(a,b) { return sleep(a + Math.random() * (b - a)); }
function safeNum(v)       { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function daysUntil(dateStr) {
  if (!dateStr) return 999;
  const d = new Date(dateStr + 'T00:00:00'), t = new Date();
  t.setHours(0,0,0,0);
  return Math.ceil((d - t) / 86400000);
}

function getEventTier(event) {
  if (isFifa(event))   return TIERS.FIFA;
  if (!event.is_major) return null;
  const d = daysUntil(event.date);
  if (d <= 7)          return TIERS.MAJOR_7D;
  if (d <= 30)         return TIERS.MAJOR_8_30D;
  return TIERS.MAJOR_30PLUS;
}

function normalizeDateString(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m) return m[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  return null;
}

function summarizePrices(prices) {
  const v = (prices||[]).map(safeNum).filter(p => p >= MIN_PRICE && p <= MAX_PRICE).sort((a,b)=>a-b);
  if (!v.length) return { floor:null, avg:null, ceiling:null };
  return { floor: Math.round(v[0]), avg: Math.round(v.reduce((a,b)=>a+b,0)/v.length), ceiling: Math.round(v[v.length-1]) };
}

function buildUrl(event) {
  // Always use the reliable short URL — let StubHub redirect if needed
  return `https://www.stubhub.com/event/${event.id}/?quantity=0`;
}

// ── Recursive JSON price/category walker ──────────────────────────────────────

function walkJson(obj, prices, categoryMap, depth) {
  if (depth > 12 || !obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(i => walkJson(i, prices, categoryMap, depth+1)); return; }

  // Total listing count hints
  // (handled in caller)

  // Individual listing price
  const raw = obj.currentPrice?.amount ?? obj.currentPrice ??
              obj.price?.amount ?? obj.price ??
              obj.listingPrice ?? obj.sellerAllInPrice ??
              obj.buyerPrice?.amount ?? obj.pricePerTicket;
  if (raw !== undefined) {
    const v = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) {
      prices.push(v);
      // Track by section
      const section = String(obj.section || obj.sectionName || obj.category || obj.categoryName || '').trim();
      if (section) {
        if (!categoryMap[section]) categoryMap[section] = [];
        categoryMap[section].push(v);
      }
    }
  }

  // Category-level floor (minPrice objects)
  const labelVal = obj.categoryName ?? obj.seatCategory ?? obj.ticketClassName ?? obj.zoneName ?? obj.zone ?? obj.label;
  const floorVal = obj.minPrice ?? obj.floorPrice ?? obj.cheapestPrice ?? obj.startingPrice;
  if (labelVal && floorVal !== undefined) {
    const label = String(labelVal).trim();
    const floor = parseFloat(String(floorVal).replace(/[^0-9.]/g, ''));
    if (label && Number.isFinite(floor) && floor >= MIN_PRICE && floor <= MAX_PRICE) {
      if (!categoryMap['__cat__' + label]) {
        categoryMap['__cat__' + label] = [floor];
      }
    }
  }

  Object.values(obj).forEach(val => walkJson(val, prices, categoryMap, depth+1));
}

// ── Scrape one event with a live browser ──────────────────────────────────────

async function scrapeEvent(browser, event) {
  const url = buildUrl(event);
  const page = await browser.newPage();

  // Block images and media — keep JS + XHR alive
  await page.route('**/*', route => {
    const t = route.request().resourceType();
    if (['image','media','font'].includes(t)) return route.abort();
    return route.continue();
  });

  const prices      = [];
  const categoryMap = {}; // section name -> [prices]  OR  __cat__Name -> [floor]
  let totalListings = 0;
  let name  = null;
  let date  = null;
  let venue = null;

  // ── Intercept every JSON response ─────────────────────────────────────────
  page.on('response', async response => {
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;

      const respUrl = response.url();
      const relevant =
        respUrl.includes('/listings') ||
        respUrl.includes('/inventory') ||
        respUrl.includes('/tickets') ||
        respUrl.includes('/event/') ||
        respUrl.includes('stubhub.com/api');
      if (!relevant) return;

      const text = await response.text().catch(() => '');
      if (!text || text.length < 50) return;
      let data;
      try { data = JSON.parse(text); } catch (_) { return; }

      // Extract total count
      if (data && typeof data === 'object') {
        const tc = data.totalListings ?? data.numFound ?? data.total ?? data.count;
        if (tc) totalListings = Math.max(totalListings, tc);
      }

      walkJson(data, prices, categoryMap, 0);
    } catch (_) {}
  });

  let success = false;

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check we landed on the right page
    const finalUrl = page.url();
    if (!finalUrl.includes(event.id)) {
      console.log(`  ✗ Redirected away from event ${event.id} → ${finalUrl.slice(0, 80)}`);
      await page.close();
      return null;
    }

    // Wait for listing data to load
    await page.waitForTimeout(4000);

    // Scroll to trigger lazy loading
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight / 2); });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(1500);

    // Pull metadata from the rendered page
    const meta = await page.evaluate(() => {
      let name = null, date = null, venue = null, total = 0;
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
          }
        } catch(_) {}
      }
      const nums = [...(document.body?.innerText || '').matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
        .map(m => parseInt(m[1].replace(/,/g,''),10)).filter(v=>v>0);
      total = nums.length ? Math.max(...nums) : 0;
      return { name, date, venue, total };
    });

    if (meta.name)  name  = meta.name;
    if (meta.date)  date  = meta.date;
    if (meta.venue) venue = meta.venue;
    if (meta.total) totalListings = Math.max(totalListings, meta.total);

    success = prices.length > 0;

  } catch (e) {
    console.log(`  ✗ Browser error: ${e.message.slice(0, 80)}`);
  }

  await page.close();

  if (!success) return null;

  // Build category list from categoryMap
  const categories = [];
  for (const [key, vals] of Object.entries(categoryMap)) {
    const floor = Math.min(...vals);
    if (!Number.isFinite(floor) || floor < MIN_PRICE || floor > MAX_PRICE) continue;

    if (key.startsWith('__cat__')) {
      // Direct category floor object from JSON
      const catName = key.replace('__cat__', '');
      if (/categ|zone|hospitality|lower|upper|field|pitch|club/i.test(catName)) {
        categories.push({ name: catName, floor: Math.round(floor) });
      }
    } else {
      // Section-level data from listing responses
      if (/categ|cat\s*\d|zone|hospitality|lower|upper|field|pitch|club/i.test(key)) {
        categories.push({ name: key, floor: Math.round(floor) });
      }
    }
  }

  return { prices, name, date, venue, totalListings, categories };
}

// ── Post to VKT API ───────────────────────────────────────────────────────────

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API + '/api/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!r.ok) { console.error('  Snapshot failed:', r.status); return false; }
    return true;
  } catch (e) { console.error('  Snapshot error:', e.message); return false; }
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
  const { data } = await supabase.from('volume_snapshots').select('id')
    .eq('event_id', eventId).is('section', null).gte('scraped_at', since).limit(1);
  return !!(data && data.length > 0);
}

// ── Worker ────────────────────────────────────────────────────────────────────

async function worker(workerId, browser, queue, results) {
  while (true) {
    const item = queue.shift();
    if (!item) break;

    const { event, tier } = item;
    const origName = event.name || 'Event ' + event.id;

    console.log(`[W${workerId}][${tier.label}] ${origName} (${event.id})`);

    try {
      const extracted = await scrapeEvent(browser, event);

      if (!extracted || !extracted.prices.length) {
        console.log(`[W${workerId}] ✗ No data for ${origName}`);
        results.failed++;
        continue;
      }

      let name  = extracted.name || origName;
      if (name.toLowerCase().includes('tickets')) name = origName;
      const venue = extracted.venue || event.venue || null;
      const date  = normalizeDateString(extracted.date) || event.date || null;
      const { prices, totalListings, categories } = extracted;

      const summary = summarizePrices(prices);
      if (!summary.floor) {
        console.log(`[W${workerId}] ✗ No valid prices for ${name}`);
        results.failed++;
        continue;
      }

      const catLog = categories.length
        ? ' | cats: ' + categories.slice(0, 4).map(c => `${c.name}=$${c.floor}`).join(', ')
        : '';

      console.log(`[W${workerId}] ✓ ${name} | ${totalListings} total, ${prices.length} priced, floor $${summary.floor}, avg $${summary.avg}, ceiling $${summary.ceiling}${catLog}`);

      await postSnapshot({
        eventId: event.id, eventName: name, eventDate: date, venue, platform: 'StubHub',
        totalListings, section: null, sectionListings: 0,
        eventFloor: summary.floor, eventAvg: summary.avg, eventCeiling: summary.ceiling,
        source: 'playwright'
      });

      for (const cat of categories) {
        await postSnapshot({
          eventId: event.id, eventName: name, eventDate: date, venue, platform: 'StubHub',
          totalListings: 0, section: cat.name, sectionListings: 0,
          sectionFloor: cat.floor, sectionAvg: null, sectionCeiling: summary.ceiling,
          eventFloor: null, source: 'playwright'
        });
      }

      const updates = {};
      if (name !== origName)          updates.name  = name;
      if (venue && venue !== event.venue) updates.venue = venue;
      if (date  && date  !== event.date)  updates.date  = date;
      if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id', event.id);

      results.scraped++;

    } catch (e) {
      console.error(`[W${workerId}] Error on ${event.id}:`, e.message);
      results.failed++;
    }

    await randomDelay(1000, 2500);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`VKT scraper — full browser mode, concurrency: ${CONCURRENCY}`);

  const manualId = process.argv[2];

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--no-first-run','--no-zygote','--disable-gpu']
  });

  if (manualId) {
    const queue = [{ event: { id: manualId, name: 'Manual', date: null, venue: null, is_major: true }, tier: TIERS.FIFA }];
    const results = { scraped: 0, failed: 0 };
    await worker(1, browser, queue, results);
    await browser.close();
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

  if (!queue.length) { await browser.close(); console.log('Nothing to scrape.'); return; }

  const results = { scraped: 0, failed: 0 };
  const workerCount = Math.min(CONCURRENCY, queue.length);
  console.log(`Launching ${workerCount} workers...`);

  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1, browser, queue, results)));

  await browser.close();
  console.log(`\nDone — scraped: ${results.scraped}, failed: ${results.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
