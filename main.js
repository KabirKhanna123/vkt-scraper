import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const VKT_API = process.env.VKT_API;

const MIN_PRICE = 10;
const MAX_PRICE = 25000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
});

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function summarizeForAtpCeiling(prices, knownFloor) {
  const threshold = knownFloor ? knownFloor * 0.9 : MIN_PRICE;
  const valid = prices
    .map(safeNum)
    .filter(v => v >= threshold && v <= MAX_PRICE)
    .sort((a, b) => a - b);

  if (!valid.length) return { avg: null, ceiling: null };

  return {
    avg: Math.round(valid.reduce((a, b) => a + b, 0) / valid.length),
    ceiling: Math.round(valid[valid.length - 1])
  };
}

// ==============================
// 🔥 FIXED FILTER HANDLER
// ==============================
async function dismissRecommended(page) {
  try {
    let filtersOpened = false;

    console.log('  Looking for Filters button...');
    await page.waitForTimeout(3000);

    for (let attempt = 1; attempt <= 6; attempt++) {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));

        for (const b of buttons) {
          const text = (b.innerText || '').toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const testid = (b.getAttribute('data-testid') || '').toLowerCase();

          if (text.includes('filter') || aria.includes('filter') || testid.includes('filter')) {
            b.click();
            return true;
          }
        }
        return false;
      });

      if (clicked) {
        console.log(`  Opened Filters panel on attempt ${attempt}`);
        await page.waitForTimeout(1500);
        filtersOpened = true;
        break;
      }

      console.log(`  Filters not found attempt ${attempt}/6`);
      await page.waitForTimeout(1500);
    }

    if (!filtersOpened) {
      console.log('  Filters not found — skipping');
      return;
    }

    const toggled = await page.evaluate(() => {
      const elements = document.querySelectorAll('[role="switch"], input[type="checkbox"]');

      for (const el of elements) {
        const text = (el.closest('label,div,li')?.innerText || '').toLowerCase();

        if (!text.includes('recommend')) continue;

        const isOn = el.checked || el.getAttribute('aria-checked') === 'true';

        if (isOn) {
          el.click();
          return 'Recommended tickets OFF';
        }

        return 'Already OFF';
      }

      return null;
    });

    console.log(`  ${toggled || 'Toggle not found'}`);

    try {
      const btn = page.locator('button:has-text("View")').first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(1000);
      }
    } catch {}

  } catch (e) {
    console.log('dismissRecommended error:', e.message);
  }
}

// ==============================
// MAIN
// ==============================
await Actor.init();

const crawler = new PlaywrightCrawler({
  maxConcurrency: 1,

  async requestHandler({ page }) {
    console.log('Scraping page...');

    // Remove modals
    await page.evaluate(() => {
      document.querySelectorAll('[class*="overlay"]').forEach(el => el.remove());
    });

    // WAIT FOR LISTINGS FIRST
    console.log('Waiting for listings...');
    try {
      await page.waitForFunction(
        () =>
          /\$\d+/.test(document.body.innerText) &&
          /listings/i.test(document.body.innerText),
        { timeout: 15000 }
      );
    } catch {}

    await page.waitForTimeout(3000);

    // 🔥 APPLY FIX HERE
    console.log('Turning off recommended...');
    await dismissRecommended(page);

    await page.waitForTimeout(1500);

    const prices = await page.evaluate(() => {
      const matches = [...document.body.innerText.matchAll(/\$(\d+)/g)];
      return matches.map(m => parseInt(m[1]));
    });

    const { avg, ceiling } = summarizeForAtpCeiling(prices, Math.min(...prices));

    console.log(`Prices: avg=${avg}, ceiling=${ceiling}`);
  }
});

await crawler.run([
  'https://www.stubhub.com/event/153020449/?quantity=0'
]);

await Actor.exit();
