/**
 * Garena shop step, done in real Chrome exactly like a person would:
 *   1. open the shop page for the game
 *   2. type the player ID into the "Player ID" box and click Login
 *   3. start the payment (same pay/init request the shop frontend sends)
 *
 * The customer never has to log in themselves - only their player ID is needed.
 *
 * Bot protection (DataDome) may show a captcha on login. This code does NOT try
 * to solve or evade it: in visible mode it alerts you and waits for a human to
 * solve it in the Chrome window, then continues. In headless mode it fails the job.
 */
const axios = require('axios');
const log = require('./logger');
const { HEADLESS } = require('./browser');

const SHOP_ORIGIN = process.env.SHOP_ORIGIN || 'https://shop.garena.my';
const CAPTCHA_WAIT_MS = Number(process.env.CAPTCHA_WAIT_MS || 3 * 60 * 1000);
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || '';

const DEFAULTS = {
    appId: Number(process.env.APP_ID || 100067),
    channelId: Number(process.env.CHANNEL_ID || 221179),
    shopRegion: process.env.SHOP_REGION || 'MY',
    playerRegion: process.env.PLAYER_REGION || 'BD', // '' = skip region check
};

const PLAYER_INPUT = 'input[placeholder*="player ID" i]';
const CAPTCHA_FRAME = 'iframe[src*="captcha-delivery.com"]';

class ShopError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const human = (min, max) => sleep(min + Math.random() * (max - min));

async function alertOperator(event, data) {
    log.warn(`ALERT ${event}`, data || '');
    if (!ALERT_WEBHOOK) return;
    await axios.post(ALERT_WEBHOOK, { event, ...data, at: new Date().toISOString() }, { timeout: 5000 })
        .catch(e => log.error('Alert webhook failed:', e.message));
}

async function openShop(page, opts) {
    await page.goto(`${SHOP_ORIGIN}/?app=${opts.appId}&channel=${opts.channelId}`, { waitUntil: 'networkidle2' });

    // Persistent profile: drop any player left over from the previous job
    if (!(await page.$(PLAYER_INPUT))) {
        await page.evaluate(() => fetch('/api/auth/logout', { headers: { Accept: 'application/json' } }).catch(() => {}));
        await page.reload({ waitUntil: 'networkidle2' });
    }
    await page.waitForSelector(PLAYER_INPUT, { visible: true });
}

async function submitPlayerId(page, playerId) {
    const input = await page.$(PLAYER_INPUT);
    await input.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await input.type(String(playerId), { delay: 60 + Math.random() * 60 });
    await human(300, 700);

    const loginResponse = page.waitForResponse(
        r => r.url().includes('/api/auth/player_id_login') && r.request().method() === 'POST',
        { timeout: 30000 },
    );
    // The Login button is the submit button of the same form as the player ID box
    await page.evaluate(sel => {
        const form = document.querySelector(sel).closest('form');
        const btn = form && form.querySelector('button[type=submit]');
        if (btn) btn.click(); else form?.requestSubmit();
    }, PLAYER_INPUT);

    const res = await loginResponse;
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status(), data };
}

async function waitForHumanCaptcha(page, playerId) {
    if (HEADLESS) {
        await alertOperator('captcha_required', { playerId, note: 'Headless mode cannot show captcha. Run with HEADLESS=false.' });
        throw new ShopError('Shop asked for captcha verification. Please try again shortly.', 'CAPTCHA_REQUIRED');
    }
    await alertOperator('captcha_required', { playerId, note: 'Solve the captcha in the Chrome window.' });
    await page.bringToFront().catch(() => {});

    const deadline = Date.now() + CAPTCHA_WAIT_MS;
    await sleep(2000);
    while (Date.now() < deadline) {
        // The page may reload while the human solves it - ignore those moments
        const stillThere = await page.$(CAPTCHA_FRAME).then(Boolean).catch(() => true);
        if (!stillThere) return; // solved / dismissed
        await sleep(2000);
    }
    throw new ShopError('Captcha was not solved in time.', 'CAPTCHA_TIMEOUT');
}

async function loginPlayer(page, playerId, opts) {
    let login = await submitPlayerId(page, playerId);

    if (login.status === 403 && login.data?.url?.includes('captcha')) {
        await waitForHumanCaptcha(page, playerId);
        await human(800, 1500);
        await openShop(page, opts); // page state after a captcha is unknown - start the form fresh
        login = await submitPlayerId(page, playerId);
    }
    if (login.status !== 200) {
        throw new ShopError(`Shop login failed (HTTP ${login.status})`, 'LOGIN_HTTP');
    }

    const player = login.data || {};
    if (!player.nickname) throw new ShopError(player.error === 'invalid_id' || !player.error ? 'Invalid player ID' : player.error, 'INVALID_PLAYER');
    if (opts.playerRegion && player.region !== opts.playerRegion) {
        throw new ShopError(`Player region ${player.region} not allowed`, 'REGION');
    }
    return player;
}

// Runs inside the shop page: same request the shop frontend sends on "Proceed to payment"
async function inPagePayInit(opts) {
    const readCookie = n => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
    const rnd = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

    let csrf = readCookie('__csrf__');
    if (!csrf) {
        csrf = rnd(16);
        document.cookie = `__csrf__=${csrf}; path=/; secure; samesite=lax`;
    }
    const res = await fetch(`/api/shop/pay/init?language=en&region=${encodeURIComponent(opts.shopRegion)}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({
            service: 'pc',
            app_id: opts.appId,
            packed_role_id: 0,
            channel_id: opts.channelId,
            channel_data: { payment_channel: null, need_return: true, invoice: [] },
            revamp_experiment: {
                session_id: rnd(16), group: 'control2',
                service_version: 'payment_center_frontend_20240611', source: 'pc', domain: location.host,
            },
        }),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, url: data?.init?.url || null, error: data?.error || null };
}

/**
 * Logs the player in on the shop (in the given Chrome tab) and returns the UniPin payment URL.
 * @returns {Promise<{url:string, nickname:string, region:string}>}
 * @throws {ShopError}
 */
async function createPaymentLink(page, playerId, options = {}) {
    const opts = { ...DEFAULTS };
    for (const [k, v] of Object.entries(options)) if (v !== undefined && v !== null) opts[k] = v;

    await openShop(page, opts);
    const player = await loginPlayer(page, playerId, opts);
    log.info(`Logged in player ${playerId} (${player.nickname}, ${player.region})`);

    await human(400, 900);
    const pay = await page.evaluate(inPagePayInit, opts);
    if (pay.status !== 200 || !pay.url) {
        throw new ShopError(pay.error || `Failed to initiate payment (HTTP ${pay.status})`, 'PAY_INIT');
    }
    return { url: pay.url, nickname: player.nickname, region: player.region };
}

module.exports = { createPaymentLink, ShopError, SHOP_ORIGIN };
