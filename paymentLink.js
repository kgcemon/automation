const axios = require('axios');
const https = require('https');
require('dotenv').config();

const BASE_URL = 'https://shop.garena.my';
const APP_ID = 100067;
const CHANNEL_ID = Number(process.env.GARENA_CHANNEL_ID || 221179);

const agent = new https.Agent({ keepAlive: true });

// Session values come from .env (copy them from your own browser's DevTools
// after logging in on shop.garena.my). Nothing secret lives in the source code.
const config = {
    cookie: process.env.GARENA_COOKIE || '',
    csrfToken: process.env.GARENA_CSRF_TOKEN || '',
    userAgent: process.env.GARENA_USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Cookie jar seeded from .env and kept up to date from Set-Cookie headers,
// so a refreshed session_key / __csrf__ is reused on the next request.
const jar = parseCookies(config.cookie);

function parseCookies(str) {
    const out = {};
    for (const part of String(str).split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

function storeCookies(response) {
    for (const c of response.headers['set-cookie'] || []) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
}

function cookieHeader() {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function headers(extra = {}) {
    return {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Origin': BASE_URL,
        'Referer': `${BASE_URL}/app`,
        'User-Agent': config.userAgent,
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieHeader(),
        ...extra,
    };
}

async function post(path, body, extraHeaders) {
    const res = await axios.post(`${BASE_URL}${path}`, body, {
        headers: headers(extraHeaders),
        httpsAgent: agent,
        timeout: 20000,
        validateStatus: () => true,
    });
    storeCookies(res);
    return res;
}

// Turns a Garena HTTP response into a readable error, or null when OK.
function responseError(res, step) {
    if (res.status === 403) return `Garena blocked the ${step} request (403). Refresh GARENA_COOKIE in .env.`;
    if (res.status === 429) return `Garena rate limited the ${step} request (429). Try again later.`;
    if (res.status >= 400) return `Garena ${step} failed with HTTP ${res.status}`;
    if (typeof res.data !== 'object' || res.data === null) return `Garena ${step} returned an unexpected response`;
    return null;
}

/**
 * Logs the player in on shop.garena.my and creates a UniPin payment link.
 * @returns {Promise<{url: string, nickname: string} | {error: string}>}
 */
const paymentLink = async (playerId) => {
    try {
        // 1) Player lookup
        const login = await post('/api/auth/player_id_login', {
            app_id: APP_ID,
            login_id: String(playerId),
            app_server_id: 0,
        });

        const loginErr = responseError(login, 'login');
        if (loginErr) return { error: loginErr };

        const player = login.data;
        if (player.error || !player.nickname) return { error: 'Invalid Player ID' };
        if (player.region !== 'BD') return { error: 'Only For BD Region!' };

        // 2) Payment init -> UniPin link
        const csrf = jar['__csrf__'] || config.csrfToken;
        const init = await post('/api/shop/pay/init?language=en&region=MY', {
            service: 'pc',
            app_id: APP_ID,
            packed_role_id: 0,
            channel_id: CHANNEL_ID,
            channel_data: { payment_channel: null, need_return: true, invoice: [] },
            revamp_experiment: {
                session_id: '',
                group: 'control2',
                service_version: 'payment_center_frontend_20240611',
                source: 'pc',
                domain: 'shop.garena.my',
            },
        }, csrf ? { 'X-CSRF-Token': csrf } : {});

        const initErr = responseError(init, 'payment init');
        if (initErr) return { error: initErr };

        if (init.data.error === 'error_require_login') {
            return { error: 'Garena session expired. Refresh GARENA_COOKIE / GARENA_CSRF_TOKEN in .env.' };
        }
        if (!init.data.init || !init.data.init.url) {
            return { error: `Failed to initiate payment${init.data.error ? `: ${init.data.error}` : ''}` };
        }

        return { url: init.data.init.url, nickname: player.nickname };
    } catch (error) {
        console.error('paymentLink error:', error.message);
        return { error: `Garena request failed: ${error.message}` };
    }
};

module.exports = { paymentLink };
