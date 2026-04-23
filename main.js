import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_KEY';
const VKT_API = process.env.VKT_API || 'https://vkt-volume-api.vercel.app';

const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || '20', 10);
const FIFA_EVENT_LIMIT = parseInt(process.env.FIFA_EVENT_LIMIT || '104', 10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  return null;
}

function summarizeForAtpCeiling(prices, knownFloor) {
  const threshold = knownFloor ? knownFloor * 0.9 : MIN_PRICE;
  const valid = prices.map(safeNum).filter(v => v >= threshold && v <= MAX_PRICE).sort((a, b) => a - b);
  if (!valid.length) return { avg: null, ceiling: null };
  return {
    avg: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length - 1]),
  };
}

function buildUrl(event) {
  if (event.stubhub_url) return event.stubhub_url.split('?')[0].replace(/\/$/, '') + '/?quantity=0';
  if (event.name && event.date) {
    try {
      const nameSlug = event.name.toLowerCase().replace(/\s+at\s+/i, ' ').replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
      let citySlug = '';
      if (event.venue) {
        const parts = event.venue.split(',');
        if (parts.length >= 2) citySlug = parts[1].trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
      }
      const d = new Date(event.date + 'T12:00:00');
      const dateSlug = `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
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
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() + 12);
  const end = cutoff.toISOString().slice(0, 10);
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      console.error('Snapshot failed:', r.status, await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Snapshot error:', e.message);
    return false;
  }
}

async function dismissModals(page) {
  await page.evaluate(() => {
    const modal = document.querySelector('#modal-root');
    if (modal) modal.innerHTML = '';
    document.querySelectorAll('[class*="overlay"]').forEach(el => {
      try {
        if (window.getComputedStyle(el).position === 'fixed') el.remove();
      } catch (_) {}
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
      if (await el.isVisible({ timeout: 300 })) {
        await el.click({ timeout: 700 });
        await page.waitForTimeout(200);
      }
    } catch (_) {}
  }
}

async function openFiltersPanel(page) {
  const opened = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role="button"], span, a, div')];
    const btn = els.find(el => {
      if (el.closest('#vkt-sidebar')) return false;
      const text = (el.textContent || '').trim();
      return /^filters?$/i.test(text);
    });
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (opened) {
    console.log('  Opened Filters panel');
    await page.waitForTimeout(900);
  }

  return opened;
}

async function clickPriceSort(page) {
  const clicked = await page.evaluate(() => {
    const allEls = [...document.querySelectorAll('label, [role="radio"], [role="option"], li, span, div, button')];
    for (const el of allEls) {
      if (el.closest('#vkt-sidebar')) continue;
      if ((el.textContent || '').trim() === 'Price') {
        const input = el.querySelector('input[type="radio"]') || el.previousElementSibling;
        if (input && input.type === 'radio') input.click();
        el.click();
        return true;
      }
    }
    return false;
  });

  if (clicked) {
    console.log('  Clicked Price sort');
    await page.waitForTimeout(500);
  }

  return clicked;
}

async function turnOffRecommendedCheckbox(page) {
  const result = await page.evaluate(() => {
    const exact = document.querySelector('input[type="checkbox"][aria-label="Recommended passes"]');
    if (exact && exact.checked) {
      exact.click();
      return 'exact';
    }

    const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')];
    for (const cb of checkboxes) {
      if (cb.closest('#vkt-sidebar')) continue;
      const label =
        (cb.getAttribute('aria-label') || cb.closest('label')?.textContent || '').toLowerCase();
      if (label.includes('recommended') && cb.checked) {
        cb.click();
        return 'fallback';
      }
    }

    return null;
  });

  if (result === 'exact') {
    console.log('  Turned off Recommended passes checkbox');
    await page.waitForTimeout(500);
    return true;
  }
  if (result === 'fallback') {
    console.log('  Turned off recommended checkbox (fallback)');
    await page.waitForTimeout(500);
    return true;
  }

  return false;
}

async function clickApplyFilters(page) {
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(el => {
        if (el.closest('#vkt-sidebar')) return false;
        const text = (el.textContent || '').trim();
        return /view\s*\d+|view\s+listings?|apply/i.test(text);
      });
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (clicked) {
    console.log('  Applied filters');
    await page.waitForTimeout(1800);
  }

  return clicked;
}

async function clickRecommendedChipFallback(page) {
  const clicked = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('button, [role="button"], [class*="chip"], [class*="filter"], [class*="Filter"]')]
      .filter(el => {
        if (el.closest('#vkt-sidebar')) return false;
        return /recommended/i.test((el.textContent || '').trim());
      });

    for (const chip of chips) {
      const isActive =
        chip.getAttribute('aria-pressed') === 'true' ||
        chip.getAttribute('aria-selected') === 'true' ||
        /active|selected|pressed|on/i.test(chip.classList.toString());

      if (isActive) {
        chip.click();
        return true;
      }
    }
    return false;
  });

  if (clicked) {
    console.log('  Turned off Recommended chip (fallback)');
    await page.waitForTimeout(1000);
  }

  return clicked;
}

// Main StubHub filter fix adapted from extension + section-scraper
async function dismissRecommended(page) {
  await dismissModals(page);

  let changed = false;

  // Try the exact extension flow first
  const opened = await openFiltersPanel(page);
  if (opened) {
    await clickPriceSort(page);
    const recOff = await turnOffRecommendedCheckbox(page);
    if (recOff) changed = true;
    await clickApplyFilters(page);
  }

  // Fallback: chip/toggle style UI
  const chipOff = await clickRecommendedChipFallback(page);
  if (chipOff) changed = true;

  // Extra hardening: direct locators if the UI changed
  const locatorCandidates = [
    'input[type="checkbox"][aria-label="Recommended passes"]',
    'button:has-text("Recommended")',
    '[aria-pressed="true"]:has-text("Recommended")',
    '[aria-selected="true"]:has-text("Recommended")',
  ];

  for (const sel of locatorCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        if (sel.startsWith('input')) {
          const checked = await el.isChecked().catch(() => false);
          if (checked) {
            await el.click({ timeout: 800 });
            console.log(`  Turned off Recommended via locator: ${sel}`);
            changed = true;
          }
        } else {
          await el.click({ timeout: 800 });
          console.log(`  Clicked Recommended toggle via locator: ${sel}`);
          changed = true;
        }
        await page.waitForTimeout(1200);
      }
    } catch (_) {}
  }

  if (!changed) {
    console.log('  Recommended filter not found or already off');
  }

  await dismissModals(page);
  await page.waitForTimeout(1200);
}

async function waitForCategoryButtons(page, timeout = 8000) {
  try {
    await page.waitForSelector('[data-testid="event-detail-zone-chip"]', { timeout });
    return true;
  } catch (_) {}

  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('button')).some(b => /^Category\s+\d/i.test((b.innerText || '').trim())),
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
          const value = parseFloat(match[1].replace(/,/g, ''));
          if (Number.isFinite(value) && value >= minPrice && value <= maxPrice) prices.add(value);
        }
      } catch (_) {
        continue;
      }
    }
    return [...prices].sort((a, b) => a - b);
  }, { minPrice: MIN_PRICE, maxPrice: MAX_PRICE });
}

async function getListingCount(page) {
  return await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const matches = [...bodyText.matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(v => Number.isFinite(v) && v > 0);
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
          label: labelMatch ? labelMatch[0] : `Category ${i + 1}`,
          floor: priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null,
          index: i,
        };
      });
    }

    return Array.from(document.querySelectorAll('button'))
      .filter(b => /^Category\s+\d/i.test((b.innerText || '').trim()))
      .map((b, i) => {
        const aria = b.getAttribute('aria-label') || '';
        const priceMatch = aria.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        return {
          label: (b.innerText || '').trim().split('\n')[0].trim(),
          floor: priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null,
          index: i,
        };
      });
  });
}

async function interceptNextCategoryUrl(page) {
  await page.evaluate(() => {
    window.__capturedCategoryUrl = null;
    if (!window.__origFetch) window.__origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (
        url.includes('ticketClasses=') &&
        (url.includes('/event/') || url.includes('stubhub')) &&
        !url.includes('google') &&
        !url.includes('doubleclick') &&
        !url.includes('viagogo')
      ) {
        window.__capturedCategoryUrl = url.startsWith('http') ? url : 'https://www.stubhub.com' + url;
      }
      return window.__origFetch.apply(this, args);
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
      id,
      name: 'Manual FIFA Event',
      date: null,
      venue: null,
      platform: 'StubHub',
      is_major: true,
      stubhub_url: null,
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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
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
            await route.abort();
            return;
          }
          await route.continue();
        } catch (_) {
          try { await route.continue(); } catch (_) {}
        }
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
    if (title) console.log(`  Title: ${title.slice(0, 100)}`);

    if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(title)) {
      const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
      if (request.url !== shortUrl) {
        console.log('  Wrong page, retrying...');
        await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500);
        const newTitle = await page.title().catch(() => '');
        if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(newTitle)) {
          console.log('  Still wrong, skipping');
          return;
        }
      } else {
        return;
      }
    }

    await dismissModals(page);

    console.log('  Waiting for listings/prices...');
    try {
      await page.waitForFunction(
        () => /\$\s*\d+/.test(document.body?.innerText || '') && /listings?/i.test(document.body?.innerText || ''),
        { timeout: 15000 }
      );
    } catch (_) {
      await page.waitForTimeout(1500);
    }

    await page.waitForTimeout(1200);
    await dismissModals(page);
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
      console.log(`  Floors: ${categoryButtons.map(c => `${c.label}=$${c.floor}`).join(', ')}`);
    }

    const categoryData = [];
    const baseUrl = request.url.split('?')[0];

    if (categoryButtons.length > 0) {
      for (const cat of categoryButtons) {
        try {
          await interceptNextCategoryUrl(page);

          await page.evaluate((idx) => {
            const chips = document.querySelectorAll('[data-testid="event-detail-zone-chip"]');
            if (chips[idx]) {
              chips[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              return;
            }
            const btns = Array.from(document.querySelectorAll('button'))
              .filter(b => /^Category\s+\d/i.test((b.innerText || '').trim()));
            if (btns[idx]) btns[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }, cat.index);

          await page.waitForTimeout(1200);
          const categoryUrl = await getCapturedUrl(page);

          if (categoryUrl) {
            console.log(`  ${cat.label}: loading category URL`);
            await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);
            await dismissModals(page);

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
          console.log(`  ${cat.label} error: ${e.message.slice(0, 80)}`);
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
        avg: atps.length ? Math.round(atps.reduce((a, b) => a + b, 0) / atps.length) : null,
        ceiling: ceilings.length ? Math.max(...ceilings) : null,
      };
    } else {
      const prices = await extractPricesFromPage(page);
      const valid = prices.filter(p => p >= MIN_PRICE && p <= MAX_PRICE).sort((a, b) => a - b);
      eventSummary = valid.length
        ? {
            floor: Math.round(valid[0]),
            avg: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
            ceiling: Math.round(valid[valid.length - 1]),
          }
        : { floor: null, avg: null, ceiling: null };
    }

    if (!eventSummary.floor) {
      console.log(`  No pricing for ${name}`);
      return;
    }

    console.log(`  ${name} | floor=$${eventSummary.floor}, atp=$${eventSummary.avg}, ceiling=$${eventSummary.ceiling}`);

    await postSnapshot({
      eventId,
      eventName: name,
      eventDate: date,
      venue,
      platform: 'StubHub',
      totalListings,
      section: null,
      sectionListings: 0,
      eventFloor: eventSummary.floor,
      eventAvg: eventSummary.avg,
      eventCeiling: eventSummary.ceiling,
      source: 'apify',
    });

    for (const cat of categoryData) {
      if (!cat.floor) continue;
      await postSnapshot({
        eventId,
        eventName: name,
        eventDate: date,
        venue,
        platform: 'StubHub',
        totalListings: 0,
        section: cat.label,
        sectionListings: cat.listings,
        sectionFloor: cat.floor,
        sectionAvg: cat.avg,
        sectionCeiling: cat.ceiling,
        eventFloor: eventSummary.floor,
        eventAvg: eventSummary.avg,
        eventCeiling: eventSummary.ceiling,
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
