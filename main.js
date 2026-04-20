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
// One daily run handles everything. Each event is assigned a tier based on
// type and days until the event. recentHours controls how long to wait before
// scraping the same event again.
//
//  FIFA events                        → always daily  (recentHours: 22)
//  Major events  0–7 days out         → daily         (recentHours: 22)
//  Major events  8–30 days out        → every 2 days  (recentHours: 46)
//  Major events  31+ days out         → every 3 days  (recentHours: 70)
//  Non-major events                   → skipped entirely
//
const TIERS = {
  FIFA:          { label: 'FIFA',        recentHours: 22 },
  MAJOR_7D:      { label: 'DAILY',       recentHours: 22 },
  MAJOR_8_30D:   { label: 'EVERY_2D',    recentHours: 46 },
  MAJOR_30PLUS:  { label: 'EVERY_3D',    recentHours: 70 },
};

function isFifa(event) {
  return !!(event.name && /world cup/i.test(event.name));
}

function daysUntil(dateStr) {
  if (!dateStr) return 999;
  const eventDate = new Date(dateStr + 'T00:00:00');
  const today     = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24));
}

function getEventTier(event) {
  if (isFifa(event))       return TIERS.FIFA;
  if (!event.is_major)     return null;   // skip non-major non-FIFA events
  const days = daysUntil(event.date);
  if (days <= 7)           return TIERS.MAJOR_7D;
  if (days <= 30)          return TIERS.MAJOR_8_30D;
  return TIERS.MAJOR_30PLUS;
}

// ─────────────────────────────────────────────────────────────────────────────

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
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }
  return null;
}

function summarizePrices(prices) {
  const valid = (prices||[]).map(safeNum)
    .filter(v => v >= MIN_PRICE && v <= MAX_PRICE)
    .sort((a,b) => a-b);
  if (!valid.length) return { floor:null, avg:null, ceiling:null };
  return {
    floor:   Math.round(valid[0]),
    avg:     Math.round(valid.reduce((a,b) => a+b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length-1])
  };
}

function extractCategoryFloorsFromHtml(html) {
  const categories = [];
  const ariaMatches = [...html.matchAll(/aria-label="[^"]*Category\s+(\d+)[^"]*?\$\s*([\d,]+)/gi)];
  for (const m of ariaMatches) {
    const catNum = parseInt(m[1], 10);
    const floor  = parseInt(m[2].replace(/,/g,''), 10);
    if (catNum >= 1 && catNum <= 10 && floor >= MIN_PRICE && floor <= MAX_PRICE) {
      if (!categories.find(c => c.category === catNum)) {
        categories.push({ category: catNum, floor });
      }
    }
  }
  if (!categories.length) {
    const jsonMatches = [...html.matchAll(/"ticketClass(?:Name|Id)?"\s*:\s*"?(\d+)"?[^}]*?"minPrice"\s*:\s*([\d.]+)/gi)];
    for (const m of jsonMatches) {
      const catNum = parseInt(m[1], 10);
      const floor  = Math.round(parseFloat(m[2]));
      if (catNum >= 1 && catNum <= 4 && floor >= MIN_PRICE && floor <= MAX_PRICE) {
        if (!categories.find(c => c.category === catNum)) {
          categories.push({ category: catNum, floor });
        }
      }
    }
  }
  return categories.sort((a,b) => a.category - b.category);
}

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
      const dateSlug = `${d.getMonth()+1}-${d.getDate()}-${d.getFullYear()}`;
      const slug = citySlug
        ? `${nameSlug}-${citySlug}-tickets-${dateSlug}`
        : `${nameSlug}-tickets-${dateSlug}`;
      return `https://www.stubhub.com/${slug}/event/${eventId}/?quantity=0`;
    } catch(_) {}
  }
  return `https://www.stubhub.com/event/${eventId}/?quantity=0`;
}

function extractCanonicalUrl(html, eventId) {
  const og = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)
           || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:url"/i);
  if (og && og[1].includes(eventId)) return og[1].split('?')[0];
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

// Check if event was scraped within the tier's recentHours window
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
    const r = await fetch(VKT_API+'/api/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) { console.error('  Snapshot failed:', r.status); return false; }
    return true;
  } catch(e) { console.error('  Snapshot error:', e.message); return false; }
}

async function fetchWithWebUnlocker(targetUrl) {
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + BRIGHTDATA_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        zone: WEB_UNLOCKER_ZONE,
        url: targetUrl,
        format: 'raw',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      })
    });
    const text = await res.text();
    if (!res.ok) { console.error('  BrightData error:', res.status); return null; }
    try {
      const json = JSON.parse(text);
      return json.body || json.html || json.content || null;
    } catch(_) {}
    return text;
  } catch(e) {
    console.error('  Fetch error:', e.message);
    return null;
  }
}

async function dismissModals(page) {
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Continue")',
    'button:has-text("Close")',
    'button[aria-label="Close"]'
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({timeout:400})) {
        await el.click({timeout:500});
        await page.waitForTimeout(200);
      }
    } catch(_) {}
  }
}

async function extractPageData(page) {
  return await page.evaluate(({minPrice, maxPrice}) => {
    let name = null, date = null, venue = null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const items = [].concat(JSON.parse(script.textContent));
        for (const item of items) {
          if (!item || (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent')) continue;
          if (!name && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
          if (!date && item.startDate) date = item.startDate;
          if (!venue && item.location?.name) {
            const city  = item.location.address?.addressLocality || '';
            const state = item.location.address?.addressRegion || '';
            venue = [item.location.name, city, state].filter(Boolean).join(', ');
          }
          if (name && date && venue) break;
        }
      } catch(_) {}
      if (name && date && venue) break;
    }
    const bodyText = document.body?.innerText || '';
    const listingMatches = [...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
      .map(m => parseInt(m[1].replace(/,/g,''), 10))
      .filter(v => Number.isFinite(v) && v > 0);
    const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;
    const prices = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      try {
        if (!node.parentElement) continue;
        if (node.parentElement.closest('script,style,noscript,svg')) continue;
        const style = window.getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        for (const match of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
          const v = parseFloat(match[1].replace(/,/g,''));
          if (Number.isFinite(v) && v >= minPrice && v <= maxPrice) prices.push(v);
        }
      } catch(_) {}
    }
    prices.sort((a,b) => a-b);
    return { name, date, venue, totalListings, prices };
  }, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE });
}

// ── Worker ────────────────────────────────────────────────────────────────────
async function worker(workerId, context, queue, results) {
  const page = await context.newPage();

  // Block images, fonts, media — major speed + cost savings
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image','media','font','stylesheet'].includes(type)) return route.abort();
    return route.continue();
  });

  while (true) {
    const item = queue.shift();
    if (!item) break;

    const { event, tier } = item;
    const eventId  = event.id;
    const origName = event.name || 'Event ' + eventId;

    console.log(`[W${workerId}][${tier.label}] ${origName} (${eventId})`);

    try {
      const url  = buildStubHubUrl(event);
      let html   = await fetchWithWebUnlocker(url);

      if (!isCorrectEventPage(html, eventId)) {
        const short = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
        if (short !== url) html = await fetchWithWebUnlocker(short);
      }

      if (!isCorrectEventPage(html, eventId)) {
        console.log(`[W${workerId}] ✗ Wrong page for ${eventId}`);
        results.failed++;
        continue;
      }

      const categoryFloors = extractCategoryFloorsFromHtml(html);
      if (categoryFloors.length) {
        console.log(`[W${workerId}]   ${categoryFloors.map(c=>`Cat${c.category}=$${c.floor}`).join(' | ')}`);
      }

      const canonicalUrl = extractCanonicalUrl(html, eventId);

      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await dismissModals(page);

      const data = await extractPageData(page);
      let name   = data.name || origName;
      if (name.toLowerCase().includes('tickets')) name = origName;
      const venue = data.venue || event.venue || null;
      const date  = normalizeDateString(data.date) || event.date || null;
      const { totalListings, prices } = data;

      const summary = summarizePrices(prices);
      if (!summary.floor) {
        console.log(`[W${workerId}] ✗ No pricing for ${name}`);
        results.failed++;
        continue;
      }

      console.log(`[W${workerId}] ✓ ${name} | ${totalListings} listings, floor $${summary.floor}, atp $${summary.avg}`);

      await postSnapshot({
        eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
        totalListings, section: null, sectionListings: 0,
        eventFloor: summary.floor, eventAvg: summary.avg, eventCeiling: summary.ceiling,
        source: 'brightdata'
      });

      for (const cat of categoryFloors) {
        await postSnapshot({
          eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
          totalListings: 0,
          section: `Category ${cat.category}`,
          sectionListings: 0,
          sectionFloor: cat.floor,
          sectionAvg: null,
          sectionCeiling: summary.ceiling,
          eventFloor: null,
          source: 'brightdata'
        });
      }

      const updates = {};
      if (name !== origName)                              updates.name         = name;
      if (venue && venue !== event.venue)                 updates.venue        = venue;
      if (date  && date  !== event.date)                  updates.date         = date;
      if (canonicalUrl && canonicalUrl !== event.stubhub_url) updates.stubhub_url = canonicalUrl;
      if (Object.keys(updates).length) {
        await supabase.from('events').update(updates).eq('id', eventId);
      }

      results.scraped++;

    } catch(e) {
      console.error(`[W${workerId}] Error on ${eventId}:`, e.message);
      results.failed++;
    }

    await randomDelay(SCRAPE_DELAY_MS, SCRAPE_DELAY_MS + 1000);
  }

  await page.close();
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`VKT scraper — concurrency: ${CONCURRENCY}`);

  const manualId = process.argv[2];

  if (manualId) {
    // Manual single-event run bypasses all tier logic
    const queue   = [{ event: { id: manualId, name: 'Manual', date: null, venue: null, stubhub_url: null }, tier: TIERS.FIFA }];
    const results = { scraped: 0, failed: 0 };
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-first-run','--no-zygote','--disable-gpu'] });
    const context = await browser.newContext({ viewport:{width:1280,height:900}, locale:'en-US', timezoneId:'America/New_York', javaScriptEnabled:false });
    await worker(1, context, queue, results);
    await browser.close();
    console.log(`Done — scraped: ${results.scraped}, failed: ${results.failed}`);
    return;
  }

  // ── 1. Fetch all events ───────────────────────────────────────────────────
  const allEvents = await getEvents();

  // ── 2. Assign tiers, skip non-eligible ───────────────────────────────────
  const tierCounts = { FIFA: 0, DAILY: 0, EVERY_2D: 0, EVERY_3D: 0, SKIPPED: 0 };

  const tieredEvents = allEvents
    .filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i) // deduplicate
    .map(event => {
      const tier = getEventTier(event);
      if (!tier) { tierCounts.SKIPPED++; return null; }
      return { event, tier };
    })
    .filter(Boolean);

  tieredEvents.forEach(({ tier }) => {
    if (tier.label === 'FIFA')       tierCounts.FIFA++;
    else if (tier.label === 'DAILY') tierCounts.DAILY++;
    else if (tier.label === 'EVERY_2D') tierCounts.EVERY_2D++;
    else if (tier.label === 'EVERY_3D') tierCounts.EVERY_3D++;
  });

  console.log(`Tier breakdown — FIFA: ${tierCounts.FIFA} | Daily: ${tierCounts.DAILY} | Every 2d: ${tierCounts.EVERY_2D} | Every 3d: ${tierCounts.EVERY_3D} | Skipped (non-major): ${tierCounts.SKIPPED}`);

  // ── 3. Filter out recently scraped (per-tier window) in parallel ─────────
  const recentFlags = await Promise.all(
    tieredEvents.map(({ event, tier }) => scrapedRecently(event.id, tier.recentHours))
  );

  const queue = tieredEvents.filter((_, i) => !recentFlags[i]);
  const skippedRecent = tieredEvents.length - queue.length;

  console.log(`Skipping ${skippedRecent} recently scraped — ${queue.length} events to process`);

  // Log breakdown of what's actually running
  const runCounts = { FIFA: 0, DAILY: 0, EVERY_2D: 0, EVERY_3D: 0 };
  queue.forEach(({ tier }) => {
    if (tier.label === 'FIFA')          runCounts.FIFA++;
    else if (tier.label === 'DAILY')    runCounts.DAILY++;
    else if (tier.label === 'EVERY_2D') runCounts.EVERY_2D++;
    else if (tier.label === 'EVERY_3D') runCounts.EVERY_3D++;
  });
  console.log(`This run — FIFA: ${runCounts.FIFA} | Daily: ${runCounts.DAILY} | Every 2d: ${runCounts.EVERY_2D} | Every 3d: ${runCounts.EVERY_3D}`);

  if (!queue.length) { console.log('Nothing to scrape.'); return; }

  // ── 4. Launch parallel workers ────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--no-first-run','--no-zygote','--disable-gpu',
      '--disable-images','--blink-settings=imagesEnabled=false'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    javaScriptEnabled: false
  });

  const results    = { scraped: 0, failed: 0 };
  const workerCount = Math.min(CONCURRENCY, queue.length);
  console.log(`Launching ${workerCount} workers...`);

  await Promise.all(
    Array.from({ length: workerCount }, (_, i) => worker(i + 1, context, queue, results))
  );

  await browser.close();
  console.log(`\nDone — scraped: ${results.scraped}, failed: ${results.failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
