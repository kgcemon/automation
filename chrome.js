/**
 * npm run chrome
 * Opens the automation's Chrome as a normal Chrome window (same profile + DevTools
 * port the server uses) on the shop page. Use it like your own Chrome: log in once
 * with any player ID and solve a verification if shown. Leave it open - the server
 * attaches to this window and works in new tabs.
 */
require('dotenv').config();
process.env.KEEP_CHROME_OPEN = 'true';
const { getBrowser } = require('./browser');
const SHOP = process.env.SHOP_ORIGIN || 'https://shop.garena.my';

(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.goto(`${SHOP}/?app=${process.env.APP_ID || 100067}`, { waitUntil: 'domcontentloaded' });
    console.log('Chrome is ready. You can use it normally; keep it open while the server runs.');
    await browser.disconnect();
    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
