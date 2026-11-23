require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const log = require('./logger');
const { withPage, getBrowser, closeBrowser } = require('./browser');
const { createPaymentLink } = require('./paymentLink');
const { redeemVoucher } = require('./topup');
const { addTransaction, updateTransaction, findTransaction } = require('./database');

const app = express();
const PORT = process.env.PORT || 4000;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 6 * 60 * 1000); // includes captcha wait
const JOB_GAP_MS = Number(process.env.JOB_GAP_MS || 1500);                   // pause between jobs, be gentle with the site
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 50);
const LOG_DIR = path.resolve(process.env.LOG_DIR || './logs');

app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_PER_MIN || 5),
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: false, message: 'Too many requests, please try again later.' },
});

// ---------- Job queue: one Chrome job at a time, in arrival order ----------
const queue = [];
let running = false;
let stats = { done: 0, failed: 0, current: null };

function enqueue(job) {
    queue.push(job);
    drain();
}

async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
        const job = queue.shift();
        stats.current = job.uid;
        try {
            await runJob(job);
        } catch (e) {
            log.error(`Job ${job.uid} crashed:`, e);
        }
        stats.current = null;
        if (queue.length) await new Promise(r => setTimeout(r, JOB_GAP_MS));
    }
    running = false;
}

function withTimeout(promise, ms) {
    let t;
    return Promise.race([
        promise,
        new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('Job timed out'), { code: 'TIMEOUT' })), ms); }),
    ]).finally(() => clearTimeout(t));
}

async function runJob(job) {
    const started = Date.now();
    log.info(`Job ${job.uid} start player=${job.playerId} denom=${job.denom}`);
    try {
        const result = await withTimeout(withPage(async page => {
            try {
                const link = await createPaymentLink(page, job.playerId, job.shopOptions);
                const { resultUrl } = await redeemVoucher(page, link.url, job);
                return { nickname: link.nickname, resultUrl };
            } catch (e) {
                await saveFailureScreenshot(page, job.uid);
                throw e;
            }
        }), JOB_TIMEOUT_MS);

        stats.done++;
        log.info(`Job ${job.uid} success in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        await finish(job, { status: true, message: 'Transaction successful', extra: result.resultUrl, nickname: result.nickname });
    } catch (e) {
        stats.failed++;
        const known = e.code && e.code !== 'TIMEOUT';
        log.error(`Job ${job.uid} failed [${e.code || 'ERR'}]: ${e.message}`);
        await finish(job, {
            status: false,
            message: known ? e.message : (e.code === 'TIMEOUT' ? 'Transaction timed out' : 'Transaction Failed'),
            code: e.code || 'ERROR',
        });
        // A timeout can leave Chrome in a bad state; start fresh next time
        if (e.code === 'TIMEOUT') await closeBrowser();
    }
}

// Screenshot of the tab when a job fails -> logs/fail-<uid>.png (kept: last 30)
async function saveFailureScreenshot(page, uid) {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        await page.screenshot({ path: path.join(LOG_DIR, `fail-${uid}.png`) });
        const shots = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('fail-'))
            .map(f => ({ f, t: fs.statSync(path.join(LOG_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
        for (const { f } of shots.slice(30)) fs.unlinkSync(path.join(LOG_DIR, f));
    } catch (e) {
        log.warn(`Screenshot failed: ${e.message}`);
    }
}

async function finish(job, payload) {
    payload.uid = job.uid;
    try {
        await updateTransaction(job.uid, payload.status ? 'success' : 'failed', payload.message, payload.extra ?? null);
    } catch (e) {
        log.error(`Failed to update transaction ${job.uid}: ${e}`);
    }
    for (let i = 1; i <= 3; i++) {
        try {
            await axios.post(job.webhook, payload, { timeout: 10000 });
            return;
        } catch (e) {
            log.warn(`Webhook attempt ${i} failed for ${job.uid}: ${e.message}`);
            await new Promise(r => setTimeout(r, i * 2000));
        }
    }
}

// ---------- Routes ----------
const isUrl = s => typeof s === 'string' && /^https?:\/\//.test(s);

app.post('/topup', limiter, async (req, res) => {
    const { playerId, denom, type, voucherCode, webhook,
            appId, channelId, shopRegion, playerRegion, paymentSelector } = req.body || {};

    const denomIndex = Number(denom);
    if (!/^[A-Za-z0-9_-]{3,30}$/.test(String(playerId || '')) || !Number.isInteger(denomIndex) || denomIndex < 0
        || !voucherCode || typeof voucherCode !== 'string' || !isUrl(webhook)) {
        return res.status(400).json({ status: false, message: 'Invalid request parameters' });
    }
    if (queue.length >= MAX_QUEUE) {
        return res.status(503).json({ status: false, message: 'Server busy, please try again later.' });
    }

    const uid = uuidv4();
    try {
        await addTransaction(uid, 'processing', 'Transaction set to Processing');
    } catch (e) {
        log.error(`Failed to add transaction: ${e}`);
        return res.status(500).json({ status: false, message: 'Failed to start transaction' });
    }

    enqueue({
        uid, playerId: String(playerId), denom: denomIndex, type, voucherCode: voucherCode.trim(), webhook, paymentSelector,
        shopOptions: { appId, channelId, shopRegion, playerRegion },
    });
    res.status(200).json({ status: true, message: 'Transaction set to Processing', uid, position: queue.length });
});

app.get('/transactions/:uid', async (req, res) => {
    try {
        const row = await findTransaction(req.params.uid);
        if (!row) return res.status(400).json({ status: false, message: 'Invalid transaction uid' });
        res.status(200).json(row);
    } catch (e) {
        log.error('Transaction lookup failed:', e);
        res.status(500).json({ status: false, message: 'Internal server error' });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: true, queue: queue.length, running, ...stats, uptime: Math.round(process.uptime()) });
});

app.get('/', (req, res) => res.json({ status: true, service: 'topup-automation' }));

require('./cron');

const server = app.listen(PORT, () => {
    log.info(`Listening on port ${PORT}`);
    // Warm up Chrome so the first order is fast
    getBrowser().catch(e => log.error('Chrome failed to start:', e.message));
});

async function shutdown(signal) {
    log.info(`${signal} received, shutting down`);
    server.close();
    await closeBrowser();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => log.error('Unhandled rejection:', e));
