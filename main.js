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

await Actor.init();

const input = await Actor.getInput() || {};
const manualEventId = input.eventId || null;

let events;
if (manualEventId) {
  // For manual runs, fetch the real event data from Supabase so we have name/venue/date/stubhub_url
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
  requestHandlerTimeoutSecs: 120,
  navigationTimeoutSecs: 45,

  async requestHandler({ page, request }) {
    const { event } = request.userData;
    const eventId = event.id;
    const originalName = event.name || 'Event ' + eventId;

    console.log(`\nScraping: ${originalName} (${eventId})`);
    console.log(`  URL: ${request.url}`);

    // Check if redirected to wrong page
    const title = await page.title();
    console.log(`  Title: ${title.slice(0, 100)}`);

    if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(title)) {
      console.log(`  Wrong page, retrying with short URL...`);
      const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
      if (request.url !== shortUrl) {
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

    // Wait for ticket prices to render
    console.log('  Waiting for prices to render...');
    try {
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        return /\$\s*\d+/.test(text) && /listings?/i.test(text);
      }, { timeout: 20000 });
      console.log('  Prices detected.');
    } catch(_) {
      console.log('  Price wait timed out, extracting anyway...');
      await page.waitForTimeout(5000);
    }

    const html = await page.content();
    const canonicalUrl = extractCanonicalUrl(html, eventId);

    const data = await page.evaluate(({ minPrice, maxPrice }) => {
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
            const value = parseFloat(match[1].replace(/,/g, ''));
            if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) prices.push(value);
          }
        } catch(_) { continue; }
      }
      prices.sort((a, b) => a - b);

      return { name, date, venue, totalListings, prices };
    }, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE });

    let name = data.name || originalName;
    if (name && name.toLowerCase().includes('tickets')) name = originalName;
    const venue = data.venue || event.venue || null;
    const date = normalizeDateString(data.date) || event.date || null;
    const { totalListings, prices } = data;

    console.log(`  Listings found: ${totalListings}, Prices found: ${prices.length}`);

    const summary = summarizePrices(prices);
    if (!summary.floor) {
      console.log(`  No pricing for ${name}`);
      return;
    }

    console.log(`  ${name} | ${date} | ${venue}`);
    console.log(`  ${totalListings} listings, floor $${summary.floor}, atp $${summary.avg}`);

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
