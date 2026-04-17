import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://unypasitbzulafehbqtj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVueXBhc2l0Ynp1bGFmZWhicXRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwMTE2MjAsImV4cCI6MjA5MDU4NzYyMH0.ywGB7ZccbVxcgZDXMOQB9Ui8R-SF4xF0SKkWavDbRGI';
const VKT_API   = process.env.VKT_API   || 'https://vkt-volume-api.vercel.app';

// ── TIER SYSTEM ──
// TIER=quick  → floor + listings only, every 6h, top matches only (cheapest)
// TIER=daily  → floor + listings + all categories + ATP + ceiling (default)
// TIER=full   → everything, all events (weekly)
const TIER         = (process.env.TIER || 'daily').toLowerCase();
const RECENT_HOURS = parseInt(process.env.RECENT_HOURS || (TIER === 'quick' ? '6' : '20'), 10);
const EVENT_LIMIT  = parseInt(process.env.EVENT_LIMIT  || '200', 10);
const CAT_WAIT_MS  = parseInt(process.env.CAT_WAIT_MS  || '2000', 10);
const MIN_PRICE = 10;
const MAX_PRICE = 25000;

// Top 10 FIFA matches — finals, semis, USA, major nations
const TOP_FIFA_KEYWORDS = [
  'final', 'semifinal', 'semi-final', 'quarter', 'round of 16',
  'united states', 'usa', 'mexico', 'england', 'brazil', 'argentina',
  'france', 'germany', 'spain', 'portugal'
];

// Knockout stage keywords
const KNOCKOUT_KEYWORDS = [
  'final', 'semifinal', 'semi-final', 'quarter', 'round of 16', 'round of 32'
];

console.log(`\n▶ VKT Scraper — TIER: ${TIER.toUpperCase()} | RECENT_HOURS: ${RECENT_HOURS} | EVENT_LIMIT: ${EVENT_LIMIT}\n`);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizeDateString(value) {
  if (!value) return null;
  const s = String(value).trim();
  const isoMatch = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  return null;
}

function summarizeForAtpCeiling(prices, knownFloor) {
  const threshold = knownFloor ? knownFloor * 0.9 : MIN_PRICE;
  const valid = prices.map(safeNum).filter(v => v >= threshold && v <= MAX_PRICE).sort((a,b) => a-b);
  if (!valid.length) return { avg: null, ceiling: null };
  return { avg: Math.round(valid.reduce((a,b) => a+b,0)/valid.length), ceiling: Math.round(valid[valid.length-1]) };
}

function buildUrl(event) {
  if (event.stubhub_url) return event.stubhub_url.split('?')[0].replace(/\/$/, '') + '/?quantity=0';
  if (event.name && event.date) {
    try {
      const nameSlug = event.name.toLowerCase().replace(/\s+at\s+/i,' ').replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'-');
      let citySlug = '';
      if (event.venue) { const parts = event.venue.split(','); if (parts.length>=2) citySlug=parts[1].trim().toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'-'); }
      const d = new Date(event.date+'T12:00:00');
      const dateSlug = `${d.getMonth()+1}-${d.getDate()}-${d.getFullYear()}`;
      return `https://www.stubhub.com/${citySlug?nameSlug+'-'+citySlug:nameSlug}-tickets-${dateSlug}/event/${event.id}/?quantity=0`;
    } catch(_) {}
  }
  return `https://www.stubhub.com/event/${event.id}/?quantity=0`;
}

function extractCanonicalUrl(html, eventId) {
  const m = html.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i) || html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i);
  return m && m[1].includes(eventId) ? m[1].split('?')[0] : null;
}

function isTopMatch(name) {
  const n = (name||'').toLowerCase();
  return TOP_FIFA_KEYWORDS.some(k => n.includes(k));
}

function isKnockoutMatch(name) {
  const n = (name||'').toLowerCase();
  return KNOCKOUT_KEYWORDS.some(k => n.includes(k));
}

async function getFifaEvents() {
  let query = supabase.from('events').select('id,name,date,venue,platform,is_major,stubhub_url').ilike('name','%world cup%').order('date',{ascending:true});
  const { data, error } = await query;
  if (error) { console.error('FIFA fetch error:', error.message); return []; }
  let events = data || [];

  // Filter by tier
  if (TIER === 'quick') {
    events = events.filter(e => isTopMatch(e.name));
    console.log(`  Quick tier: filtered to ${events.length} top FIFA matches`);
  } else if (TIER === 'daily') {
    events = events.filter(e => isKnockoutMatch(e.name) || isTopMatch(e.name));
    // If fewer than 20 knockout matches, include all
    if (events.length < 20) events = data || [];
    console.log(`  Daily tier: ${events.length} FIFA matches`);
  }
  // full tier: all events, no filter

  return events;
}

async function getOtherEvents(limit) {
  if (TIER === 'quick') return []; // quick tier: FIFA only
  const { data, error } = await supabase.from('events').select('id,name,date,venue,platform,is_major,stubhub_url')
    .not('id','like','tm_%').not('name','ilike','%world cup%').not('name','ilike','%football 2026 event%')
    .not('name','ilike','%basketball 2026 event%').not('name','ilike','%baseball 2026 event%')
    .not('name','ilike','%hockey 2026 event%').not('name','ilike','%soccer 2026 event%')
    .not('name','ilike','% tickets').not('name','ilike','%2026 event')
    .order('date',{ascending:true}).limit(limit);
  if (error) { console.error('Other events fetch error:', error.message); return []; }
  return data || [];
}

async function scrapedRecently(eventId) {
  const since = new Date(Date.now() - RECENT_HOURS*3600000).toISOString();
  const { data } = await supabase.from('volume_snapshots').select('id').eq('event_id',eventId).is('section',null).gte('scraped_at',since).limit(1);
  return !!(data && data.length>0);
}

async function postSnapshot(payload) {
  try {
    const r = await fetch(VKT_API+'/api/snapshot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    if (!r.ok) { console.error('Snapshot failed:', r.status); return false; }
    return true;
  } catch(e) { console.error('Snapshot error:', e.message); return false; }
}

async function dismissModals(page) {
  await page.evaluate(() => {
    const modal = document.querySelector('#modal-root'); if (modal) modal.innerHTML='';
    document.querySelectorAll('[class*="overlay"]').forEach(el => { if(window.getComputedStyle(el).position==='fixed') el.remove(); });
  });
  for (const sel of ['button:has-text("Accept")','button:has-text("Continue")','button:has-text("Close")','button[aria-label="Close"]']) {
    try { const el=page.locator(sel).first(); if(await el.isVisible({timeout:200})) await el.click({timeout:300}); } catch(_){}
  }
}

async function turnOffRecommendedFilter(page) {
  try {
    // Method 1: Uncheck the "Recommended passes" checkbox directly
    const unchecked = await page.evaluate(() => {
      // Try aria-label first
      const cb = document.querySelector('input[type="checkbox"][aria-label*="ecommended"]');
      if (cb && cb.checked) { cb.click(); return 'aria-label checkbox'; }

      // Try any checked checkbox near "recommended" text
      const allCbs = document.querySelectorAll('input[type="checkbox"]');
      for (const c of allCbs) {
        const label = (c.getAttribute('aria-label') || c.closest('label')?.textContent || '').toLowerCase();
        if (label.includes('recommend') && c.checked) { c.click(); return 'label checkbox'; }
      }

      // Try clicking a "Filters" button to open panel
      return null;
    });

    if (unchecked) {
      console.log(`  Turned off Recommended filter (${unchecked})`);
      await page.waitForTimeout(800);
      return;
    }

    // Method 2: Open filters panel and uncheck recommended
    const filterBtn = page.locator('button:has-text("Filters"), button:has-text("Filter")').first();
    if (await filterBtn.isVisible({ timeout: 2000 })) {
      await filterBtn.click();
      await page.waitForTimeout(600);

      // Sort by Price
      try {
        const priceOption = page.locator('label:has-text("Price"), [role="radio"]:has-text("Price")').first();
        if (await priceOption.isVisible({ timeout: 1000 })) await priceOption.click();
      } catch(_) {}

      // Uncheck recommended
      try {
        const recCb = page.locator('input[type="checkbox"][aria-label*="ecommended"]').first();
        if (await recCb.isVisible({ timeout: 1000 })) {
          const isChecked = await recCb.isChecked();
          if (isChecked) { await recCb.click(); console.log('  Turned off Recommended (filter panel)'); }
        }
      } catch(_) {}

      // Apply / close filter panel
      try {
        const applyBtn = page.locator('button:has-text("View"), button:has-text("Apply"), button:has-text("Done")').first();
        if (await applyBtn.isVisible({ timeout: 1000 })) await applyBtn.click();
      } catch(_) {}

      await page.waitForTimeout(1000);
    }
  } catch(e) {
    console.log(`  turnOffRecommendedFilter skipped: ${e.message.slice(0,50)}`);
  }
}

async function waitForPrices(page, timeout=20000) {
  try { await page.waitForFunction(()=>/\$\s*\d+/.test(document.body?.innerText||'')&&/listings?/i.test(document.body?.innerText||''),{timeout}); } catch(_){}
}

async function extractPricesFromPage(page) {
  return await page.evaluate(({minPrice,maxPrice})=>{
    const prices=new Set();
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    let node;
    while((node=walker.nextNode())){
      try{
        if(!node.parentElement) continue;
        if(node.parentElement.closest('script,style,noscript,svg,header,footer,nav')) continue;
        const style=window.getComputedStyle(node.parentElement);
        if(style.display==='none'||style.visibility==='hidden') continue;
        for(const m of node.textContent.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)){
          const v=parseFloat(m[1].replace(/,/g,''));
          if(Number.isFinite(v)&&v>=minPrice&&v<=maxPrice) prices.add(v);
        }
      }catch(_){continue;}
    }
    return [...prices].sort((a,b)=>a-b);
  },{minPrice:MIN_PRICE,maxPrice:MAX_PRICE});
}

async function getListingCount(page) {
  return await page.evaluate(()=>{
    const matches=[...( document.body?.innerText||'').matchAll(/\b(\d[\d,]*)\s+listings?\b/gi)].map(m=>parseInt(m[1].replace(/,/g,''),10)).filter(v=>Number.isFinite(v)&&v>0);
    return matches.length?Math.max(...matches):0;
  });
}

async function getCategoryButtons(page) {
  return await page.evaluate(()=>{
    const chips=Array.from(document.querySelectorAll('[data-testid="event-detail-zone-chip"]'));
    if(chips.length>0) return chips.map((b,i)=>{
      const aria=b.getAttribute('aria-label')||'';
      const pm=aria.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      const lm=aria.match(/Category\s+\d+/i);
      return{label:lm?lm[0]:`Category ${i+1}`,floor:pm?parseFloat(pm[1].replace(/,/g,'')):null,index:i};
    });
    return Array.from(document.querySelectorAll('button')).filter(b=>/^Category\s+\d/i.test((b.innerText||'').trim())).map((b,i)=>{
      const aria=b.getAttribute('aria-label')||'';
      const pm=aria.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      return{label:(b.innerText||'').trim().split('\n')[0].trim(),floor:pm?parseFloat(pm[1].replace(/,/g,'')):null,index:i};
    });
  });
}

// Scrape all categories IN ONE PAGE SESSION — no extra navigations
async function scrapeCategoriesInPage(page, categoryButtons) {
  const categoryData = [];
  for (const cat of categoryButtons) {
    try {
      await page.evaluate((idx)=>{
        const chips=document.querySelectorAll('[data-testid="event-detail-zone-chip"]');
        if(chips[idx]){chips[idx].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return;}
        const btns=Array.from(document.querySelectorAll('button')).filter(b=>/^Category\s+\d/i.test((b.innerText||'').trim()));
        if(btns[idx]) btns[idx].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      }, cat.index);

      await page.waitForTimeout(CAT_WAIT_MS);

      const catPrices = await extractPricesFromPage(page);
      const catListings = await getListingCount(page);
      const floor = cat.floor;
      const { avg, ceiling } = summarizeForAtpCeiling(catPrices, floor);

      console.log(`  ${cat.label}: ${catListings} listings, floor $${floor}, atp $${avg}, ceiling $${ceiling}`);
      categoryData.push({ label: cat.label, listings: catListings, floor, avg, ceiling });
    } catch(e) {
      console.log(`  ${cat.label} error: ${e.message.slice(0,60)}`);
      categoryData.push({ label: cat.label, listings: 0, floor: cat.floor, avg: null, ceiling: null });
    }
  }
  return categoryData;
}

// ── MAIN ──
await Actor.init();
const input = await Actor.getInput() || {};
const manualEventId = input.eventId || null;

let events;
if (manualEventId) {
  const { data } = await supabase.from('events').select('id,name,date,venue,platform,is_major,stubhub_url').eq('id',manualEventId).limit(1);
  events = data?.length>0 ? data : [{id:manualEventId,name:'Manual',date:null,venue:null,platform:'StubHub',is_major:false,stubhub_url:null}];
} else {
  const fifaEvents = await getFifaEvents();
  const remainingSlots = Math.max(0, EVENT_LIMIT - fifaEvents.length);
  const otherEvents = remainingSlots > 0 ? await getOtherEvents(remainingSlots) : [];
  events = [...fifaEvents, ...otherEvents];
  console.log(`FIFA: ${fifaEvents.length}, Other: ${otherEvents.length}, Total: ${events.length}`);
}

const requests = [];
for (const event of events) {
  if (!manualEventId && await scrapedRecently(event.id)) continue;
  requests.push({ url: buildUrl(event), userData: { event } });
}
console.log(`URLs to scrape: ${requests.length}`);

const crawler = new PlaywrightCrawler({
  proxyConfiguration: await Actor.createProxyConfiguration({ groups:['RESIDENTIAL'], countryCode:'US' }),
  launchContext: { launchOptions: { headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'] } },
  browserPoolOptions: { useFingerprints: true },
  maxRequestRetries: 1,
  requestHandlerTimeoutSecs: TIER==='quick' ? 90 : 180,
  navigationTimeoutSecs: 45,

  async requestHandler({ page, request }) {
    const { event } = request.userData;
    const eventId = event.id;
    const originalName = event.name || 'Event ' + eventId;

    console.log(`\nScraping [${TIER.toUpperCase()}]: ${originalName}`);

    const title = await page.title();
    if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(title)) {
      const shortUrl = `https://www.stubhub.com/event/${eventId}/?quantity=0`;
      if (request.url !== shortUrl) {
        await page.goto(shortUrl, { waitUntil:'domcontentloaded', timeout:45000 });
        await page.waitForTimeout(2000);
        if (/Schedule|NFL \d{4}|NBA \d{4}|MLB \d{4}|NHL \d{4}/i.test(await page.title())) { console.log('  Wrong page, skipping'); return; }
      } else return;
    }

    await dismissModals(page);
    await waitForPrices(page, 20000);
    await page.waitForTimeout(1000);
    await dismissModals(page);
    // Turn off Recommended filter to see ALL listings
    await turnOffRecommendedFilter(page);
    await page.waitForTimeout(500);
    try { await page.waitForSelector('[data-testid="event-detail-zone-chip"]',{timeout:8000}); } catch(_){}

    const html = await page.content();
    const canonicalUrl = extractCanonicalUrl(html, eventId);

    const meta = await page.evaluate(()=>{
      let name=null,date=null,venue=null;
      for(const script of document.querySelectorAll('script[type="application/ld+json"]')){
        try{
          const items=[JSON.parse(script.textContent)].flat();
          for(const item of items){
            if(!item||typeof item!=='object') continue;
            if(item['@type']!=='Event'&&item['@type']!=='SportsEvent') continue;
            if(!name&&item.name&&!item.name.toLowerCase().includes('tickets')) name=item.name;
            if(!date&&item.startDate) date=item.startDate;
            if(!venue&&item.location?.name){const city=item.location.address?.addressLocality||'';const state=item.location.address?.addressRegion||'';venue=[item.location.name,city,state].filter(Boolean).join(', ');}
            if(name&&date&&venue) break;
          }
        }catch(_){}
        if(name&&date&&venue) break;
      }
      return{name,date,venue};
    });

    let name = meta.name || originalName;
    if (name?.toLowerCase().includes('tickets')) name = originalName;
    const venue = meta.venue || event.venue || null;
    const date = normalizeDateString(meta.date) || event.date || null;
    const totalListings = await getListingCount(page);
    const categoryButtons = await getCategoryButtons(page);

    console.log(`  ${categoryButtons.length} categories, ${totalListings} listings`);

    let categoryData = [];
    let eventSummary;

    if (categoryButtons.length > 0) {
      if (TIER === 'quick') {
        // Quick tier: floor from aria-label only — no category clicking at all
        const floors = categoryButtons.map(c=>c.floor).filter(Boolean);
        eventSummary = {
          floor: floors.length ? Math.min(...floors) : null,
          avg: null,
          ceiling: null
        };
        console.log(`  Quick: floor $${eventSummary.floor} from aria-labels only`);
      } else {
        // Daily/full tier: scrape all categories in one page session
        categoryData = await scrapeCategoriesInPage(page, categoryButtons);
        const floors = categoryData.map(c=>c.floor).filter(Boolean);
        const ceilings = categoryData.map(c=>c.ceiling).filter(Boolean);
        const atps = categoryData.map(c=>c.avg).filter(Boolean);
        eventSummary = {
          floor: floors.length ? Math.min(...floors) : null,
          avg: atps.length ? Math.round(atps.reduce((a,b)=>a+b,0)/atps.length) : null,
          ceiling: ceilings.length ? Math.max(...ceilings) : null
        };
      }
    } else {
      const prices = await extractPricesFromPage(page);
      const valid = prices.filter(p=>p>=MIN_PRICE&&p<=MAX_PRICE).sort((a,b)=>a-b);
      eventSummary = valid.length ? {
        floor: Math.round(valid[0]),
        avg: TIER==='quick' ? null : Math.round(valid.reduce((a,b)=>a+b,0)/valid.length),
        ceiling: TIER==='quick' ? null : Math.round(valid[valid.length-1])
      } : {floor:null,avg:null,ceiling:null};
    }

    if (!eventSummary.floor) { console.log(`  No pricing for ${name}`); return; }
    console.log(`  ${name} | floor $${eventSummary.floor}, atp $${eventSummary.avg}, ceiling $${eventSummary.ceiling}`);

    await postSnapshot({
      eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
      totalListings, section:null, sectionListings:0,
      eventFloor:eventSummary.floor, eventAvg:eventSummary.avg, eventCeiling:eventSummary.ceiling,
      source:`apify-${TIER}`
    });

    for (const cat of categoryData) {
      if (!cat.floor) continue;
      await postSnapshot({
        eventId, eventName:name, eventDate:date, venue, platform:'StubHub',
        totalListings:0, section:cat.label, sectionListings:cat.listings,
        sectionFloor:cat.floor, sectionAvg:cat.avg, sectionCeiling:cat.ceiling,
        eventFloor:eventSummary.floor, eventAvg:eventSummary.avg, eventCeiling:eventSummary.ceiling,
        source:`apify-${TIER}`
      });
      console.log(`  Saved ${cat.label}: floor $${cat.floor}, atp $${cat.avg}`);
    }

    const updates = {};
    if (name!==originalName) updates.name=name;
    if (venue&&venue!==event.venue) updates.venue=venue;
    if (date&&date!==event.date) updates.date=date;
    if (canonicalUrl&&canonicalUrl!==event.stubhub_url) updates.stubhub_url=canonicalUrl;
    if (Object.keys(updates).length) await supabase.from('events').update(updates).eq('id',eventId);
  },

  failedRequestHandler({request,error}){ console.error(`Failed: ${request.url} — ${error.message}`); }
});

await crawler.addRequests(requests);
await crawler.run();
console.log('\nDone.');
await Actor.exit();
