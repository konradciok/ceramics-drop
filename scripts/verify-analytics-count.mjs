import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://anna-ciok.studio/en';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.addInitScript(() => {
  window.__eventArgs = [];
  const dl = (window.dataLayer = window.dataLayer || []);
  const origPush = dl.push.bind(dl);
  dl.push = function (...args) {
    const entry = args[0];
    if (entry && typeof entry === 'object' && entry[0] === 'event') {
      window.__eventArgs.push(entry[1]);
    }
    return origPush(...args);
  };
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForTimeout(4000);

const snapshot = await page.evaluate(() => {
  const events = window.__eventArgs ?? [];
  const byName = {};
  for (const name of events) byName[name] = (byName[name] ?? 0) + 1;
  return {
    totalGtagEvents: events.length,
    byName,
    dataLayerLength: window.dataLayer?.length ?? 0,
    gtmHasDedupe: String(document.documentElement.innerHTML).includes('__accBridgeSent'),
  };
});

console.log(JSON.stringify({ url, runId: process.argv[3] ?? 'verify', ...snapshot }, null, 2));
await browser.close();

if (snapshot.totalGtagEvents > 5) process.exit(2);
