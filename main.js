import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || '20', 10);
const FIFA_EVENT_LIMIT = parseInt(process.env.FIFA_EVENT_LIMIT || '104', 10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: ws } });

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
    return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
  }
  return null;
}

function summarizeForAtpCeiling(prices, knownFloor) {
  const threshold = knownFloor ? knownFloor * 0.9 : MIN_PRICE;
  const valid = prices.map(safeNum).filter(v => v >= threshold && v <= MAX_PRICE).sort((a,b) => a-b);
  if (!valid.length) return { avg: null, ceiling: null };
  return {
    avg: Math.round(valid.reduce((a,b) => a+b,0) / valid.length),
    ceiling: Math.round(valid[valid.length-1]),
  };
}

function buildUrl(event) {
  if (event.stubhub_url) return event.stubhub_url.split('?')[0].replace(/\/$/, '') + '/?quantity=0';
  if (event.name && event.date) {
    try {
      const nameSlug = event.name.toLowerCase().replace(/\s+at\s+/i,' ').replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'-');
      let citySlug = '';
      if (event.venue) {
        const parts = event.venue.split(',');
        if (parts.length >= 2) citySlug = parts[1].trim().toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'-');
      }
      const d = new Date(event.date + 'T12:00:00');
      const dateSlug = `${d.getMonth()+1}-${d.getDate()}-${d.getFullYear()}`;
      const slug = citySlug ? `${nameSlug}-${citySlug}-tickets-${dateSlug}` : `${nameSlug}-tickets-${dateSlug}`;
      return `https://www.stubhub.com/${slug}/event/${event.id}/?quantity=0`;
    } catch (_) {}
  }
  return `https://www.stubhub.com/event/${event.id}/?quantity=0`;
}

function extractCanonicalUrl(html, eventId) {
  const ogMatch = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i) ||
                  html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:url"/i);
  if (ogMatch && ogMatch[1].includes(eventId)) return ogMatch[1].split('?')[0];
  const canonMatch = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) ||
                     html.match(/<link[^>]+href="([^"]+)"[^>]+rel="canonical"/i);
  if (canonMatch && canonMatch[1].includes(eventId)) return canonMatch[1].split('?')[0];
  return null;
}

async function getFifaEvents(limit) {
  const today = new Date().toISOString().slice(0,10);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() + 12);
  const end = cutoff.toISOString().slice(0,10);
  const { data, error } = await supabase
    .from('events')
    .select('id,name,date,venue,platform,is_major,stubhub_url')
    .gte('date', today).lte('date', end)
    .or('name.ilike.%world cup%,name.ilike.%fifa%')
    .order('date', { ascending: true })
    .limit(limit);
  if (error) { console.error('FIFA fetch error:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS * 3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('id')
    .eq('event_id', eventId).is('section', null).gte('scraped_at', since).limit(1);
  return !!(data && data.length > 0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API + '/api/snapshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!r.ok) { console.error('Snapshot failed:', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('Snapshot error:', e.message); return false; }
}

async function dismissModals(page) {
  await page.evaluate(() => {
    const modal = document.querySelector('#modal-root');
    if (modal) modal.innerHTML = '';
    document.querySelectorAll('[class*="overlay"]').forEach(el => {
      try { if (window.getComputedStyle(el).position === 'fixed') el.remove(); } catch (_) {}
    });
  });
  for (const sel of [
    'button:has-text("Accept")',
    'button:has-text("Continue")',
    'button:has-text("Close")',
    'button[aria-label="Close"]',
    'button:has-text("Got it")',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 250 })) { await el.click({ timeout: 500 }); await page.waitForTimeout(150); }
    } catch (_) {}
  }
}

async function dismissRecommended(page) {
  try {
    // Step 1: Open the Filters panel
    const filtersBtn = page.locator('button:has-text("Filters"), [aria-label="Filters"], button:has-text("Filter")').first();
    if (await filtersBtn.isVisible({ timeout: 2000 })) {
      await filtersBtn.click({ timeout: 2000 });
      await page.waitForTimeout(800);
      console.log('  Opened Filters panel');
    }

    // Step 2: Turn off "Recommended tickets" toggle inside the panel
    const toggled = await page.evaluate(() => {
      // Find the toggle/checkbox near "Recommended tickets" text
      const labels = Array.from(document.querySelectorAll('label, div, span, button'));
      for (const el of labels) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t.toLowerCase().includes('recommended tickets') || t.toLowerCase() === 'recommended') {
          // Look for a toggle/checkbox nearby
          const parent = el.closest('[class*="filter"], [class*="Filter"], section, div') || el.parentElement;
          if (parent) {
            // Find toggle button or checkbox within parent
            const toggle = parent.querySelector('[role="switch"], input[type="checkbox"], button[aria-checked]');
            if (toggle) {
              const isOn = toggle.getAttribute('aria-checked') === 'true' ||
                           toggle.checked === true ||
                           toggle.getAttribute('data-state') === 'checked';
              if (isOn) {
                toggle.click();
                return `turned off toggle near "${t}"`;
              }
            }
            // If the element itself is clickable
            if (el.tagName === 'BUTTON' || el.role === 'switch') {
              el.click();
              return `clicked element: "${t}"`;
            }
          }
          // Try clicking the label itself
          el.click();
          return `clicked label: "${t}"`;
        }
      }
      return null;
    });

    if (toggled) {
      console.log(`  ${toggled}`);
      await page.waitForTimeout(800);
    } else {
      console.log('  Recommended toggle not found in filters panel');
    }

    // Step 3: Click "View X Listings" to apply and close the panel
    try {
      const viewBtn = page.locator('button:has-text("View"), button:has-text("Show")').first();
      if (await viewBtn.isVisible({ timeout: 1500 })) {
        await viewBtn.click({ timeout: 2000 });
        await page.waitForTimeout(800);
        console.log('  Applied filters');
      }
    } catch (_) {}

  } catch (e) {
    console.log('  dismissRecommended error:', e.message.slice(0, 80));
  }
}

async function waitForCategoryButtons(page, timeout = 8000) {
  try { await page.waitForSelector('[data-testid="event-detail-zone-chip"]', { timeout }); return true; } catch (_) {}
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('button')).some(b => /^Category\s+\d/i.test((b.innerText||'').trim())),
      { timeout: 3000 }
    );
    return true;
  } catch (_) {}
  return false;
}

async function extractPricesFromPage(page) {
  return await page.evaluate(({ minPrice, maxPrice }) => {
    const prices = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      try {
        if (!node.parentElement) continue;
        if (node.parentElement.closest('script,style,noscript,svg,header,footer,nav')) continue;
        const style = window.getComputedStyle(node.parentElement);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        for (const match of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)) {
          const value = parseFloat(match[1].replace(/,/g,''));
          if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) prices.add(value);
        }
      } catch (_) { continue; }
    }
    return [...prices].sort((a,b) => a-b);
  }, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE });
}

async function getListingCount(page) {
  return await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const matches = [...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
      .map(m => parseInt(m[1].replace(/,/g,''),10)).filter(v => Number.isFinite(v) && v > 0);
    return matches.length ? Math.max(...matches) : 0;
  });
}

async function getCategoryButtons(page) {
  return await page.evaluate(() => {
    const chipBtns = Array.from(document.querySelectorAll('[data-testid="event-detail-zone-chip"]'));
    if (chipBtns.length > 0) {
      return chipBtns.map((b, i) => {
        const aria = b.getAttribute('aria-label') || '';
        const priceMatch = aria.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        const labelMatch = aria.match(/Category\s+\d+/i);
        return {
          label: labelMatch ? labelMatch[0] : `Category ${i+1}`,
          floor: priceMatch ? parseFloat(priceMatch[1].replace(/,/g,'')) : null,
          index: i,
        };
      });
    }
    return Array.from(document.querySelectorAll('button'))
      .filter(b => /^Category\s+\d/i.test((b.innerText||'').trim()))
      .map((b, i) => {
        const aria = b.getAttribute('aria-label') || '';
        const priceMatch = aria.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        return {
          label: (b.innerText||'').trim().split('\n')[0].trim(),
          floor: priceMatch ? parseFloat(priceMatch[1].replace(/,/g,'')) : null,
          index: i,
        };
      });
  });
}

async function interceptNextCategoryUrl(page) {
  await page.evaluate(() => {
    window.__capturedCategoryUrl = null;

    // Intercept fetch
    if (!window.__origFetch) window.__origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (
        (url.includes('ticketClasses=') || url.includes('zoneMapping') || url.includes('listings')) &&
        (url.includes('/event/') || url.includes('stubhub')) &&
        !url.includes('google') && !url.includes('doubleclick') && !url.includes('viagogo')
      ) {
        window.__capturedCategoryUrl = url.startsWith('http') ? url : 'https://www.stubhub.com' + url;
        console.log('[VKT intercept fetch]', window.__capturedCategoryUrl.slice(0,120));
      }
      return window.__origFetch.apply(this, args);
    };

    // Intercept XHR too
    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open.bind(xhr);
      xhr.open = function(method, url, ...rest) {
        if (
          (url.includes('ticketClasses=') || url.includes('zoneMapping') || url.includes('listings')) &&
          (url.includes('/event/') || url.includes('stubhub')) &&
          !url.includes('google') && !url.includes('doubleclick')
        ) {
          window.__capturedCategoryUrl = url.startsWith('http') ? url : 'https://www.stubhub.com' + url;
          console.log('[VKT intercept xhr]', window.__capturedCategoryUrl.slice(0,120));
        }
        return origOpen(method, url, ...rest);
      };
      return xhr;
    };
  });
}

async function getCapturedUrl(page) {
  return await page.evaluate(() => window.__capturedCategoryUrl);
}

await Actor.init();

const input = await Actor.getInput() || {};

const rawIds = input.eventIds || input.eventId || null;
const manualIds = rawIds
  ? (Array.isArray(rawIds) ? rawIds : String(rawIds).split(',').map(s => s.trim()).filter(Boolean))
  : null;

let events;
if (manualIds && manualIds.length > 0) {
  console.log(`Manual event IDs: ${manualIds.join(', ')}`);
  const { data } = await supabase.from('events')
    .select('id,name,date,venue,platform,is_major,stubhub_url')
    .in('id', manualIds);
  const found = data || [];
  events = manualIds.map(id => {
    return found.find(e => e.id === id) || {
      id, name: 'Manual FIFA Event', date: null,
      venue: null, platform: 'StubHub', is_major: true, stubhub_url: null,
    };
  });
} else {
  events = await getFifaEvents(FIFA_EVENT_LIMIT);
  console.log(`FIFA events fetched: ${events.length}`);
}

const requests = [];
for (const event of events) {
  if (!manualIds && await scrapedRecently(event.id)) {
    console.log(`Skipping recent: ${event.name} (${event.id})`);
    continue;
  }
  requests.push({ url: buildUrl(event), userData: { event } });
}

console.log(`FIFA URLs to scrape: ${requests.length}`);

const crawler = new PlaywrightCrawler({
  proxyConfiguration: await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
    countryCode: 'US',
  }),
  launchContext: {
    launchOptions: {
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'],
    },
  },
  maxConcurrency: 1,
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: 180,
  navigationTimeoutSecs: 45,
  browserPoolOptions: { useFingerprints: true },

  preNavigationHooks: [
    async ({ page }) => {
      await page.route('**/*', async route => {
        try {
          const req = route.request();
          const type = req.resourceType();
          const url = req.url();
          if (
            type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet' ||
            url.includes('google-analytics') || url.includes('googletagmanager') ||
            url.includes('doubleclick') || url.includes('facebook') ||
            url.includes('hotjar') || url.includes('intercom') || url.includes('segment')
          ) {
            await route.abort(); return;
          }
          await route.continue();
        } catch (_) { try { await route.continue(); } catch (_) {} }
      });
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
    },
  ],

  async requestHandler({ page, request }) {
    const { event } = request.userData;
    const eventId = event.id;
    const originalName = event.name || `Event ${eventId}`;
    console.log(`\nScraping: ${originalName} (${eventId})`);

    const title = await page.title().catch(() => '');
    if (title) console.log(`  Title: ${title.slice(0,100)}`);

    if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(title)) {
      const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
      if (request.url !== shortUrl) {
        console.log('  Wrong page, retrying...');
        await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500);
        const newTitle = await page.title().catch(() => '');
        if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(newTitle)) {
          console.log('  Still wrong, skipping'); return;
        }
      } else { return; }
    }

    await dismissModals(page);

    console.log('  Waiting for listings/prices...');
    try {
      await page.waitForFunction(
        () => /\$\s*\d+/.test(document.body?.innerText||'') && /listings?/i.test(document.body?.innerText||''),
        { timeout: 15000 }
      );
    } catch (_) { await page.waitForTimeout(1500); }

    await page.waitForTimeout(1200);
    await dismissModals(page);

    // Click "Show more" and "View N Listings" to expand all listings
    try {
      const viewAll = page.locator('button:has-text("View"), button:has-text("Show more")').first();
      if (await viewAll.isVisible({ timeout: 1000 })) {
        await viewAll.click({ timeout: 1500 });
        await page.waitForTimeout(800);
        console.log('  Clicked view/show more button');
      }
    } catch (_) {}

    await dismissRecommended(page);
    await waitForCategoryButtons(page, 8000);

    const html = await page.content();
    const canonicalUrl = extractCanonicalUrl(html, eventId);

    const meta = await page.evaluate(() => {
      let name = null, date = null, venue = null;
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const items = [].concat(JSON.parse(script.textContent));
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
        } catch (_) {}
        if (name && date && venue) break;
      }
      return { name, date, venue };
    });

    let name = meta.name || originalName;
    if (name && name.toLowerCase().includes('tickets')) name = originalName;
    const venue = meta.venue || event.venue || null;
    const date = normalizeDateString(meta.date) || event.date || null;
    const totalListings = await getListingCount(page);
    const categoryButtons = await getCategoryButtons(page);

    console.log(`  Categories: ${categoryButtons.length}, listings: ${totalListings}`);
    if (categoryButtons.length > 0) {
      console.log(`  Floors: ${categoryButtons.map(c=>`${c.label}=$${c.floor}`).join(', ')}`);
    }

    const categoryData = [];
    const baseUrl = request.url.split('?')[0];

    if (categoryButtons.length > 0) {
      for (const cat of categoryButtons) {
        try {
          await interceptNextCategoryUrl(page);

          // Also capture via Playwright network interception
          let playwrightCapturedUrl = null;
          const urlHandler = (route) => {
            const url = route.request().url();
            if (
              (url.includes('ticketClasses=') || url.includes('listings')) &&
              url.includes('stubhub') &&
              !url.includes('google')
            ) {
              playwrightCapturedUrl = url;
            }
            route.continue().catch(() => {});
          };
          await page.route('**/*', urlHandler);

          await page.evaluate((idx) => {
            const chips = document.querySelectorAll('[data-testid="event-detail-zone-chip"]');
            if (chips[idx]) {
              chips[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return;
            }
            const btns = Array.from(document.querySelectorAll('button'))
              .filter(b => /^Category\s+\d/i.test((b.innerText||'').trim()));
            if (btns[idx]) btns[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }, cat.index);

          await page.waitForTimeout(1500);
          await page.unroute('**/*', urlHandler);
          const categoryUrl = (await getCapturedUrl(page)) || playwrightCapturedUrl;
          if (categoryUrl) console.log(`  ${cat.label}: captured URL = ${categoryUrl.slice(0,80)}`);

          if (categoryUrl) {
            console.log(`  ${cat.label}: loading category URL`);
            await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);
            await dismissModals(page);
            await dismissRecommended(page);
            await page.waitForTimeout(600);
            const catPrices = await extractPricesFromPage(page);
            const catListings = await getListingCount(page);
            const floor = cat.floor;
            const { avg, ceiling } = summarizeForAtpCeiling(catPrices, floor);
            console.log(`  ${cat.label}: listings=${catListings}, floor=$${floor}, atp=$${avg}, ceiling=$${ceiling}`);
            categoryData.push({ label: cat.label, listings: catListings, floor, avg, ceiling });

            await page.goto(baseUrl + '?quantity=0', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1200);
            await dismissModals(page);
            await dismissRecommended(page);
            await waitForCategoryButtons(page, 5000);
          } else {
            console.log(`  ${cat.label}: no URL captured, floor only`);
            categoryData.push({ label: cat.label, listings: 0, floor: cat.floor, avg: null, ceiling: null });
          }
        } catch (e) {
          console.log(`  ${cat.label} error: ${e.message.slice(0,80)}`);
          categoryData.push({ label: cat.label, listings: 0, floor: cat.floor, avg: null, ceiling: null });
          try {
            await page.goto(baseUrl + '?quantity=0', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1000);
            await dismissModals(page);
            await dismissRecommended(page);
            await waitForCategoryButtons(page, 5000);
          } catch (_) {}
        }
      }
    }

    let eventSummary;
    if (categoryData.length > 0) {
      const floors = categoryData.map(c => c.floor).filter(Boolean);
      const ceilings = categoryData.map(c => c.ceiling).filter(Boolean);
      const atps = categoryData.map(c => c.avg).filter(Boolean);
      eventSummary = {
        floor: floors.length ? Math.min(...floors) : null,
        avg: atps.length ? Math.round(atps.reduce((a,b)=>a+b,0)/atps.length) : null,
        ceiling: ceilings.length ? Math.max(...ceilings) : null,
      };
    } else {
      const prices = await extractPricesFromPage(page);
      const valid = prices.filter(p => p >= MIN_PRICE && p <= MAX_PRICE).sort((a,b)=>a-b);
      eventSummary = valid.length
        ? { floor: Math.round(valid[0]), avg: Math.round(valid.reduce((a,b)=>a+b,0)/valid.length), ceiling: Math.round(valid[valid.length-1]) }
        : { floor: null, avg: null, ceiling: null };
    }

    if (!eventSummary.floor) { console.log(`  No pricing for ${name}`); return; }

    console.log(`  ${name} | floor=$${eventSummary.floor}, atp=$${eventSummary.avg}, ceiling=$${eventSummary.ceiling}`);

    await postSnapshot({
      eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
      totalListings, section: null, sectionListings: 0,
      eventFloor: eventSummary.floor, eventAvg: eventSummary.avg, eventCeiling: eventSummary.ceiling,
      source: 'apify',
    });

    for (const cat of categoryData) {
      if (!cat.floor) continue;
      await postSnapshot({
        eventId, eventName: name, eventDate: date, venue, platform: 'StubHub',
        totalListings: 0, section: cat.label, sectionListings: cat.listings,
        sectionFloor: cat.floor, sectionAvg: cat.avg, sectionCeiling: cat.ceiling,
        eventFloor: eventSummary.floor, eventAvg: eventSummary.avg, eventCeiling: eventSummary.ceiling,
        source: 'apify',
      });
      console.log(`  Saved ${cat.label}: floor=$${cat.floor}, atp=$${cat.avg}, ceiling=$${cat.ceiling}`);
    }

    const updates = {};
    if (name !== originalName) updates.name = name;
    if (venue && venue !== event.venue) updates.venue = venue;
    if (date && date !== event.date) updates.date = date;
    if (canonicalUrl && canonicalUrl !== event.stubhub_url) updates.stubhub_url = canonicalUrl;
    if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id', eventId);
  },

  failedRequestHandler({ request, error }) {
    console.error(`Failed: ${request.url} — ${error.message}`);
  },
});

await crawler.addRequests(requests);
await crawler.run();

console.log('\nDone.');
await Actor.exit();
