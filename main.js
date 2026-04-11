import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || '20', 10);
const EVENT_LIMIT  = parseInt(process.env.EVENT_LIMIT  || '200', 10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizeDateString(value) {
  if (!value) return null;
  const s = String(value).trim();
  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  return null;
}

function summarizePrices(prices) {
  const valid = prices.map(safeNum).filter(v => v >= MIN_PRICE && v <= MAX_PRICE).sort((a,b) => a-b);
  if (!valid.length) return { floor:null, avg:null, ceiling:null };
  return {
    floor:   Math.round(valid[0]),
    avg:     Math.round(valid.reduce((a,b) => a+b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length-1])
  };
}

function buildUrl(event) {
  if (event.stubhub_url) {
    return event.stubhub_url.split('?')[0].replace(/\/$/, '') + '/?quantity=0';
  }
  if (event.name && event.date) {
    try {
      const nameSlug = event.name.toLowerCase().replace(/\s+at\s+/i, ' ').replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
      let citySlug = '';
      if (event.venue) {
        const parts = event.venue.split(',');
        if (parts.length >= 2) citySlug = parts[1].trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
      }
      const d = new Date(event.date + 'T12:00:00');
      const dateSlug = `${d.getMonth()+1}-${d.getDate()}-${d.getFullYear()}`;
      const slug = citySlug ? `${nameSlug}-${citySlug}-tickets-${dateSlug}` : `${nameSlug}-tickets-${dateSlug}`;
      return `https://www.stubhub.com/${slug}/event/${event.id}/?quantity=0`;
    } catch(_) {}
  }
  return `https://www.stubhub.com/event/${event.id}/?quantity=0`;
}

function extractCanonicalUrl(html, eventId) {
  const ogMatch = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:url"/i);
  if (ogMatch && ogMatch[1].includes(eventId)) return ogMatch[1].split('?')[0];
  const canonMatch = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i)
    || html.match(/<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i);
  if (canonMatch && canonMatch[1].includes(eventId)) return canonMatch[1].split('?')[0];
  return null;
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

async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS*3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('id').eq('event_id', eventId).is('section', null).gte('scraped_at', since).limit(1);
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API+'/api/snapshot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!r.ok) { console.error('Snapshot failed:', r.status, await r.text()); return false; }
    return true;
  } catch(e) { console.error('Snapshot error:', e.message); return false; }
}

async function expandAllListings(page) {
  console.log('  Expanding listings...');

  // Dismiss popups
  for (const sel of ['button:has-text("Accept")', 'button:has-text("Continue")', 'button:has-text("Close")', 'button[aria-label="Close"]']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 })) { await el.click({ timeout: 700 }); await page.waitForTimeout(300); }
    } catch(_) {}
  }

  // Find listings scroll container
  const scrollTarget = page.locator([
    '[data-testid*="list"]',
    '[data-testid*="inventory"]',
    '#listings-container',
    '[id*="listing"]',
    '[class*="listing-container"]',
    '[class*="inventory"]',
    '[class*="scroll"]'
  ].join(', ')).first();

  let previousPriceCount = 0;
  let stableRounds = 0;

  for (let round = 0; round < 30; round++) {
    // Click Show more buttons
    for (const text of ['Show more', 'See more', 'Load more', 'More listings', 'View more']) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 400 })) {
          console.log(`  Clicking "${text}"`);
          await btn.click({ timeout: 1500 });
          await page.waitForTimeout(1500);
        }
      } catch(_) {}
    }

    // Scroll listings container
    let scrolled = false;
    try {
      if (await scrollTarget.isVisible({ timeout: 400 })) {
        await scrollTarget.hover();
        for (let i = 0; i < 4; i++) {
          await scrollTarget.evaluate(el => el.scrollBy(0, Math.max(800, Math.floor(el.clientHeight * 0.9))));
          await page.waitForTimeout(600);
        }
        scrolled = true;
      }
    } catch(_) {}

    // Fallback: page scroll
    if (!scrolled) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(600);
      }
    }

    // Count visible prices to detect when loading stops
    const priceCount = await page.evaluate(() =>
      [...(document.body?.innerText || '').matchAll(/\$\s*[\d,]+(?:\.\d{2})?/g)].length
    );

    console.log(`  Round ${round + 1}: ${priceCount} price texts visible`);

    if (priceCount <= previousPriceCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      previousPriceCount = priceCount;
    }

    if (stableRounds >= 3) {
      console.log('  Listings fully expanded');
      break;
    }
  }
}

async function extractAllPrices(page, minPrice, maxPrice) {
  return await page.evaluate(({ minPrice, maxPrice }) => {
    const prices = new Set();

    // Extract from embedded script JSON
    for (const script of Array.from(document.querySelectorAll('script'))) {
      const text = script.textContent || '';
      if (text.length < 100) continue;
      const patterns = [
        /"price"\s*:\s*([\d.]+)/g,
        /"currentPrice"\s*:\s*([\d.]+)/g,
        /"listPrice"\s*:\s*([\d.]+)/g,
        /"listingPrice"\s*:\s*([\d.]+)/g,
        /"sellingPrice"\s*:\s*([\d.]+)/g,
        /"amount"\s*:\s*([\d.]+)/g,
        /"totalPrice"\s*:\s*([\d.]+)/g,
        /"displayPrice"\s*:\s*([\d.]+)/g,
        /"priceWithFees"\s*:\s*([\d.]+)/g,
      ];
      for (const pattern of patterns) {
        for (const m of text.matchAll(pattern)) {
          const v = parseFloat(m[1]);
          if (Number.isFinite(v) && v >= minPrice && v <= maxPrice) prices.add(v);
        }
      }
    }

    // Walk visible text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      try {
        if (!node.parentElement) continue;
        if (node.parentElement.closest('script,style,noscript,svg,header,footer,nav')) continue;
        const style = window.getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        for (const match of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
          const value = parseFloat(match[1].replace(/,/g, ''));
          if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) prices.add(value);
        }
      } catch(_) { continue; }
    }

    return [...prices].sort((a, b) => a - b);
  }, { minPrice, maxPrice });
}

await Actor.init();

const input = await Actor.getInput() || {};
const manualEventId = input.eventId || null;

let events;
if (manualEventId) {
  const { data } = await supabase.from('events').select('id,name,date,venue,platform,is_major,stubhub_url').eq('id', manualEventId).limit(1);
  events = data && data.length > 0
    ? data
    : [{ id: manualEventId, name: 'Manual', date: null, venue: null, platform: 'StubHub', is_major: false, stubhub_url: null }];
} else {
  events = await getEvents();
}

console.log(`Events to process: ${events.length}`);

const requests = [];
for (const event of events) {
  if (!manualEventId && await scrapedRecently(event.id)) {
    console.log(`Skipping ${event.name} (recent)`);
    continue;
  }
  requests.push({ url: buildUrl(event), userData: { event } });
}

console.log(`URLs to scrape: ${requests.length}`);

const crawler = new PlaywrightCrawler({
  proxyConfiguration: await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
  }),

  launchContext: {
    launchOptions: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    }
  },

  browserPoolOptions: { useFingerprints: true },
  maxRequestRetries: 2,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 45,

  async requestHandler({ page, request }) {
    const { event } = request.userData;
    const eventId = event.id;
    const originalName = event.name || 'Event ' + eventId;

    console.log(`\nScraping: ${originalName} (${eventId})`);

    // Intercept network responses to capture all listing prices
    const networkPrices = new Set();
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (!url.includes('/inventory') && !url.includes('/listing') && !url.includes('/event') && !url.includes('/search')) return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('application/json')) return;
        const data = await response.json();
        const text = JSON.stringify(data);
        for (const m of text.matchAll(/"(?:price|currentPrice|listPrice|listingPrice|sellingPrice|amount|displayPrice|priceWithFees)"\s*:\s*([\d.]+)/g)) {
          const v = parseFloat(m[1]);
          if (Number.isFinite(v) && v >= MIN_PRICE && v <= MAX_PRICE) networkPrices.add(v);
        }
      } catch(_) {}
    });

    const title = await page.title();
    console.log(`  Title: ${title.slice(0, 100)}`);

    if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(title)) {
      const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
      if (request.url !== shortUrl) {
        console.log('  Wrong page, retrying with short URL...');
        await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);
        const newTitle = await page.title();
        if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(newTitle)) {
          console.log('  Still wrong page, skipping');
          return;
        }
      } else {
        return;
      }
    }

    // Dismiss modals
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Continue")', 'button:has-text("Close")', 'button[aria-label="Close"]']) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) { await el.click({ timeout: 700 }); await page.waitForTimeout(300); }
      } catch(_) {}
    }

    // Wait for initial listings
    console.log('  Waiting for listings...');
    try {
      await page.waitForFunction(() => /\$\s*\d+/.test(document.body?.innerText || '') && /listings?/i.test(document.body?.innerText || ''), { timeout: 20000 });
    } catch(_) {
      await page.waitForTimeout(5000);
    }

    // Expand all listings
    await expandAllListings(page);
    await page.waitForTimeout(1500);

    const html = await page.content();
    const canonicalUrl = extractCanonicalUrl(html, eventId);

    // Extract metadata
    const meta = await page.evaluate(() => {
      let name = null, date = null, venue = null;
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const parsed = JSON.parse(script.textContent);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            if (item['@type'] !== 'Event' && item['@type'] !== 'SportsEvent') continue;
            if (!name && item.name && !item.name.toLowerCase().includes('tickets')) name = item.name;
            if (!date && item.startDate) date = item.startDate;
            if (!venue && item.location?.name) {
              const city = item.location.address?.addressLocality || '';
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
        .map(m => parseInt(m[1].replace(/,/g, ''), 10))
        .filter(v => Number.isFinite(v) && v > 0);
      const totalListings = listingMatches.length ? Math.max(...listingMatches) : 0;
      return { name, date, venue, totalListings };
    });

    // Merge DOM + network prices
    const domPrices = await extractAllPrices(page, MIN_PRICE, MAX_PRICE);
    const prices = [...new Set([...domPrices, ...networkPrices])].sort((a, b) => a - b);

    let name = meta.name || originalName;
    if (name && name.toLowerCase().includes('tickets')) name = originalName;
    const venue = meta.venue || event.venue || null;
    const date = normalizeDateString(meta.date) || event.date || null;
    const { totalListings } = meta;

    console.log(`  Listings: ${totalListings}, DOM: ${domPrices.length}, Network: ${networkPrices.size}, Total prices: ${prices.length}`);

    const summary = summarizePrices(prices);
    if (!summary.floor) { console.log(`  No pricing for ${name}`); return; }

    console.log(`  ${name} | ${date} | ${venue}`);
    console.log(`  ${totalListings} listings, floor $${summary.floor}, atp $${summary.avg}, ceiling $${summary.ceiling}`);

    await postSnapshot({
      eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
      totalListings, section: null, sectionListings: 0,
      eventFloor: summary.floor, eventAvg: summary.avg, eventCeiling: summary.ceiling,
      source: 'apify'
    });

    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (canonicalUrl && canonicalUrl !== event.stubhub_url) updates.stubhub_url = canonicalUrl;
    if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id', eventId);
  },

  failedRequestHandler({ request, error }) {
    console.error(`Failed: ${request.url} — ${error.message}`);
  }
});

await crawler.addRequests(requests);
await crawler.run();

console.log('\nDone.');
await Actor.exit();
