const { getShopPage } = require('./session');

// Defaults — every one can be overridden per request (see server.js) or via .env
const DEFAULTS = {
    appId: Number(process.env.APP_ID || 100067),
    channelId: Number(process.env.CHANNEL_ID || 221179),
    shopRegion: process.env.SHOP_REGION || 'MY',
    playerRegion: process.env.PLAYER_REGION || 'BD', // set to '' to skip region check
};

/**
 * Runs inside the shop page (browser context). Mirrors what the site does:
 *   POST /api/auth/player_id_login  { app_id, login_id }
 *   POST /api/shop/pay/init         with X-CSRF-Token = __csrf__ cookie
 */
async function inPageFlow({ playerId, opts }) {
    const readCookie = (name) => {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    };
    const json = async (res) => {
        const text = await res.text();
        try { return { status: res.status, data: JSON.parse(text) }; }
        catch { return { status: res.status, data: null, text: text.slice(0, 200) }; }
    };

    // Start clean so the previous customer's login doesn't leak into this one
    await fetch('/api/auth/logout', { headers: { Accept: 'application/json' } }).catch(() => {});

    const login = await json(await fetch('/api/auth/player_id_login', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: opts.appId, login_id: String(playerId) }),
    }));
    if (login.status !== 200) return { httpError: login.status, step: 'login', detail: login.text || login.data };

    const player = login.data || {};
    if (!player.nickname) return { error: player.error || 'Invalid player ID' };
    if (opts.playerRegion && player.region !== opts.playerRegion) {
        return { error: `Player region ${player.region} not allowed` };
    }

    const randomToken = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))]
        .map(b => b.toString(16).padStart(2, '0')).join('');

    // Double-submit CSRF: the shop frontend generates __csrf__ itself and sends
    // the same value as X-CSRF-Token. The server does not issue it.
    let csrf = readCookie('__csrf__');
    if (!csrf) {
        csrf = randomToken(16);
        document.cookie = `__csrf__=${csrf}; path=/; secure; samesite=lax`;
    }

    const sessionId = randomToken(16);

    const pay = await json(await fetch(
        `/api/shop/pay/init?language=en&region=${encodeURIComponent(opts.shopRegion)}`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
            service: 'pc',
            app_id: opts.appId,
            packed_role_id: 0,
            channel_id: opts.channelId,
            channel_data: { payment_channel: null, need_return: true, invoice: [] },
            revamp_experiment: {
                session_id: sessionId,
                group: 'control2',
                service_version: 'payment_center_frontend_20240611',
                source: 'pc',
                domain: location.host,
            },
        }),
    }));
    if (pay.status !== 200) return { httpError: pay.status, step: 'pay/init', detail: pay.text || pay.data };

    const url = pay.data?.init?.url;
    if (!url) return { error: pay.data?.error || 'Failed to initiate payment' };
    return { url, nickname: player.nickname };
}

/**
 * @param {string} playerId
 * @param {{appId?:number, channelId?:number, shopRegion?:string, playerRegion?:string}} [options]
 * @returns {Promise<string>} payment URL, or an error message string
 */
const paymentLink = async (playerId, options = {}) => {
    const opts = { ...DEFAULTS };
    for (const [k, v] of Object.entries(options)) {
        if (v !== undefined && v !== null) opts[k] = v;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const page = await getShopPage({ forceRefresh: attempt > 1 });
            const result = await page.evaluate(inPageFlow, { playerId, opts });

            if (result.httpError) {
                console.error(`paymentLink attempt ${attempt}: ${result.step} HTTP ${result.httpError}`, result.detail);
                if (attempt === 1) continue; // reload the shop page and retry once
                return `Shop returned HTTP ${result.httpError} at ${result.step}`;
            }
            return result.url || result.error;
        } catch (error) {
            console.error(`paymentLink attempt ${attempt} failed:`, error.message);
            if (attempt === 1) continue;
            return error.message;
        }
    }
};

module.exports = { paymentLink };
