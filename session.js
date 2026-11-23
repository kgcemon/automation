const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');

puppeteer.use(StealthPlugin());

const SHOP_ORIGIN = process.env.SHOP_ORIGIN || 'https://shop.garena.my';
const PAGE_TTL_MS = Number(process.env.SESSION_TTL_MS || 20 * 60 * 1000);

let browser = null;
let page = null;
let pageCreatedAt = 0;
let pending = null;

async function openShopPage() {
    if (!browser || !browser.connected) {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: executablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
    }
    if (page && !page.isClosed()) await page.close().catch(() => {});

    page = await browser.newPage();
    await page.goto(`${SHOP_ORIGIN}/app`, { timeout: 60000, waitUntil: 'networkidle2' });
    pageCreatedAt = Date.now();
    return page;
}

/**
 * Returns a live page sitting on the shop origin. API calls are made from
 * inside this page with fetch(), so cookies / CSRF are handled by the browser
 * exactly as when a person uses the site.
 */
async function getShopPage({ forceRefresh = false } = {}) {
    const stale = !page || page.isClosed() || Date.now() - pageCreatedAt > PAGE_TTL_MS;
    if (!forceRefresh && !stale) return page;

    if (!pending) {
        pending = openShopPage().finally(() => { pending = null; });
    }
    return pending;
}

async function closeBrowser() {
    if (browser) await browser.close().catch(() => {});
    browser = null;
    page = null;
}

process.on('exit', () => { if (browser) browser.process()?.kill(); });

module.exports = { getShopPage, closeBrowser, SHOP_ORIGIN };
