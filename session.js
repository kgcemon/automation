const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');

puppeteer.use(StealthPlugin());

const SHOP_ORIGIN = process.env.SHOP_ORIGIN || 'https://shop.garena.my';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 20 * 60 * 1000);

let cached = null;      // { cookies, userAgent, createdAt }
let pending = null;     // in-flight refresh promise (avoid parallel browser launches)

async function fetchFreshSession() {
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage();
        await page.goto(`${SHOP_ORIGIN}/app`, { timeout: 60000, waitUntil: 'networkidle2' });

        const cookies = await page.cookies();
        const userAgent = await page.evaluate(() => navigator.userAgent);
        if (!cookies.some(c => c.name === 'datadome')) {
            throw new Error('Could not obtain session cookies from shop page');
        }

        // __csrf__ / session_key are issued later by the player login response
        return {
            cookies: Object.fromEntries(cookies.map(c => [c.name, c.value])),
            userAgent,
            createdAt: Date.now(),
        };
    } finally {
        await browser.close();
    }
}

async function getSession({ forceRefresh = false } = {}) {
    const expired = !cached || Date.now() - cached.createdAt > SESSION_TTL_MS;
    if (!forceRefresh && !expired) return cached;

    if (!pending) {
        pending = fetchFreshSession()
            .then(s => (cached = s))
            .finally(() => { pending = null; });
    }
    return pending;
}

function invalidateSession() {
    cached = null;
}

module.exports = { getSession, invalidateSession, SHOP_ORIGIN };
