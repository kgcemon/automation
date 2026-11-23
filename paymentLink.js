const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const { getSession, invalidateSession, SHOP_ORIGIN } = require('./session');

const agent = new https.Agent({ keepAlive: true });

// Defaults — every one can be overridden per request (see server.js) or via .env
const DEFAULTS = {
    appId: Number(process.env.APP_ID || 100067),
    channelId: Number(process.env.CHANNEL_ID || 221179),
    shopRegion: process.env.SHOP_REGION || 'MY',
    playerRegion: process.env.PLAYER_REGION || 'BD', // set to '' to skip region check
};

function mergeSetCookies(jar, response) {
    for (const line of response.headers['set-cookie'] || []) {
        const [pair] = line.split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
}

function buildHeaders(session, jar, extra = {}) {
    return {
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Cookie': Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '),
        'Origin': SHOP_ORIGIN,
        'Referer': `${SHOP_ORIGIN}/app`,
        'User-Agent': session.userAgent,
        'X-Requested-With': 'XMLHttpRequest',
        ...extra,
    };
}

async function requestPaymentLink(playerId, opts, session) {
    const jar = { ...session.cookies }; // per-request copy; login adds session_key/__csrf__
    const playerRes = await axios.post(
        `${SHOP_ORIGIN}/api/auth/player_id_login`,
        { app_id: opts.appId, login_id: String(playerId), app_server_id: 0 },
        { headers: buildHeaders(session, jar), httpsAgent: agent }
    );
    mergeSetCookies(jar, playerRes);
    const player = playerRes.data;

    if (!player.nickname) return { error: 'Invalid player ID' };
    if (opts.playerRegion && player.region !== opts.playerRegion) {
        return { error: `Player region ${player.region} not allowed` };
    }

    if (!jar.__csrf__) return { error: 'No __csrf__ cookie returned by player login' };

    const payRes = await axios.post(
        `${SHOP_ORIGIN}/api/shop/pay/init?language=en&region=${encodeURIComponent(opts.shopRegion)}`,
        {
            service: 'pc',
            app_id: opts.appId,
            packed_role_id: 0,
            channel_id: opts.channelId,
            channel_data: { payment_channel: null, need_return: true, invoice: [] },
            revamp_experiment: {
                session_id: crypto.randomBytes(16).toString('hex'),
                group: 'control2',
                service_version: 'payment_center_frontend_20240611',
                source: 'pc',
                domain: new URL(SHOP_ORIGIN).host,
            },
        },
        { headers: buildHeaders(session, jar, { 'X-CSRF-Token': jar.__csrf__ }), httpsAgent: agent }
    );

    const url = payRes.data?.init?.url;
    if (!url) return { error: 'Failed to initiate payment' };
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
            const session = await getSession({ forceRefresh: attempt > 1 });
            const result = await requestPaymentLink(playerId, opts, session);
            return result.url || result.error;
        } catch (error) {
            const status = error.response?.status;
            console.error(`paymentLink attempt ${attempt} failed:`, status || '', error.message);
            // Expired/blocked session -> refresh cookies once and retry
            if (attempt === 1 && (status === 401 || status === 403 || status === 419)) {
                invalidateSession();
                continue;
            }
            return error.message;
        }
    }
};

module.exports = { paymentLink };
