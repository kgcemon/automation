const express = require("express");
const rateLimit = require('express-rate-limit');
const axios = require("axios");
const { paymentLink } = require("./paymentLink");
const { runAutomation } = require("./topup");
const { addTransaction, updateTransaction, findTransaction } = require("./database");
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;
const MAX_CODES = 5;
// Denomination button index used when the request doesn't send `denom`.
const DEFAULT_DENOM = Number(process.env.DEFAULT_DENOM || 0);

// Behind nginx: use the real client IP (X-Forwarded-For) for rate limiting
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

app.use(express.json());

// Invalid JSON body -> clean error instead of an HTML stack trace
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ status: 'error', error: 'Invalid JSON body' });
    }
    next(err);
});

// 20 requests / minute per IP, same as the ucbot docs
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { status: 'error', error: 'Rate limit exceeded' },
});

// ---------- Job queue: only one browser automation at a time ----------
let queue = Promise.resolve();
function enqueue(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
}

// ---------- Helpers ----------
function isLinkValid(link) {
    return typeof link === 'string' && /^https?:\/\//.test(link);
}

function parseCodes(body) {
    // `code` wins over `pin`. Accepts "A,B,C" or ["A","B","C"].
    const raw = body.code ?? body.pin;
    if (raw === undefined || raw === null) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    return list.map(c => String(c).trim()).filter(Boolean);
}

// BDMB -> type 1, UPBD -> type 2 (can be overridden with `type` in the body)
function detectType(code, override) {
    if (override !== undefined && override !== null && override !== '') return Number(override);
    return /^UPBD/i.test(code) ? 2 : 1;
}

function validate(body, needCallback) {
    const orderid = body.orderid !== undefined ? String(body.orderid).trim() : '';
    const playerid = body.playerid !== undefined ? String(body.playerid).trim() : '';
    const codes = parseCodes(body);

    if (!orderid || !playerid || codes.length === 0) return 'Missing required fields';
    if (needCallback && !isLinkValid(body.url)) return 'Missing required fields';
    if (!/^\d+$/.test(playerid)) return 'Invalid Player ID';
    if (codes.length > MAX_CODES) return 'Max 5 codes per order';
    if (body.denom !== undefined && !Number.isInteger(Number(body.denom))) return 'Invalid denom';
    return null;
}

function runOneCode(link, denom, type, code) {
    return new Promise((resolve) => {
        runAutomation(link, denom, type, code, (error, result) => {
            if (error) resolve({ uc: code, ok: false, detail: error.message || 'Transaction Failed' });
            else resolve({ uc: code, ok: true, detail: 'Success', result: result.message });
        });
    });
}

// Runs every code of an order one after another and returns the ucbot-style result.
async function processOrder({ orderid, playerid, codes, denom, type }) {
    const batch = [];
    let nickname = 'N/A';

    for (const code of codes) {
        const player = await paymentLink(playerid);

        if (player.error) {
            // Player problem (invalid ID / wrong region) -> whole order fails
            return {
                status: 'failed',
                orderid,
                nickname,
                error: player.error,
                content: player.error,
                batch: codes.map(uc => ({ uc, ok: false, detail: player.error })),
                total: codes.length,
                success: 0,
                failed: codes.length,
            };
        }

        nickname = player.nickname;
        batch.push(await runOneCode(player.url, denom, detectType(code, type), code));
    }

    const success = batch.filter(b => b.ok).length;
    const failed = batch.length - success;
    let status = 'failed';
    if (success === batch.length) status = 'success';
    else if (success > 0) status = 'partial';

    return {
        status,
        orderid,
        nickname,
        content: batch.length === 1 ? batch[0].detail : { batch },
        batch,
        total: batch.length,
        success,
        failed,
    };
}

async function saveResult(orderid, result) {
    const dbStatus = result.success > 0 ? 'success' : 'failed';
    try {
        await updateTransaction(orderid, dbStatus, result.status, JSON.stringify(result));
    } catch (error) {
        console.error(`Failed to update transaction ${orderid}: ${error}`);
    }
}

async function createOrder(req, res, needCallback) {
    const error = validate(req.body, needCallback);
    if (error) return { error: res.status(400).json({ status: 'error', error }) };

    const order = {
        orderid: String(req.body.orderid).trim(),
        playerid: String(req.body.playerid).trim(),
        codes: parseCodes(req.body),
        denom: req.body.denom !== undefined ? Number(req.body.denom) : DEFAULT_DENOM,
        type: req.body.type,
    };

    if (await findTransaction(order.orderid).catch(() => null)) {
        return { error: res.status(400).json({ status: 'error', error: 'Duplicate orderid' }) };
    }

    try {
        await addTransaction(order.orderid, 'processing', 'processing');
    } catch (e) {
        console.error(`Failed to add transaction: ${e}`);
        return { error: res.status(500).json({ status: 'error', error: 'Database error' }) };
    }
    return { order };
}

// ---------- Routes ----------

// Synchronous: waits for the result and returns it in the HTTP response.
app.post('/topup-sync', limiter, async (req, res) => {
    const { order, error } = await createOrder(req, res, false);
    if (error) return;

    try {
        const result = await enqueue(() => processOrder(order));
        await saveResult(order.orderid, result);

        if (result.error) {
            return res.status(400).json({ status: 'error', error: result.error, orderid: order.orderid });
        }
        res.json({
            status: 'success',
            orderid: order.orderid,
            username: result.nickname,
            total: result.total,
            success: result.success,
            failed: result.failed,
            batch: result.batch,
        });
    } catch (e) {
        console.error('topup-sync error:', e);
        await updateTransaction(order.orderid, 'failed', e.message, null).catch(() => {});
        res.status(500).json({ status: 'error', error: 'Internal error' });
    }
});

// Async: returns 202 immediately, result is POSTed to `url`.
app.post('/topup', limiter, async (req, res) => {
    const { order, error } = await createOrder(req, res, true);
    if (error) return;

    const callbackUrl = req.body.url;
    res.status(202).json({ status: 'accepted', orderid: order.orderid });

    let result;
    try {
        result = await enqueue(() => processOrder(order));
    } catch (e) {
        console.error('topup error:', e);
        result = { status: 'failed', orderid: order.orderid, nickname: 'N/A', content: e.message, batch: [], total: 0, success: 0, failed: 0 };
    }
    await saveResult(order.orderid, result);

    try {
        await axios.post(callbackUrl, {
            status: result.status,
            orderid: result.orderid,
            nickname: result.nickname,
            content: result.content,
            batch: result.batch,
        }, { timeout: 15000 });
    } catch (e) {
        console.error(`Failed to send callback for ${order.orderid}: ${e.message}`);
    }
});

// Order status by orderid
app.get('/status/:orderid', async (req, res) => {
    try {
        const row = await findTransaction(req.params.orderid);
        if (!row) return res.status(404).json({ status: 'error', error: 'Order not found' });

        let result = null;
        try { result = row.extra ? JSON.parse(row.extra) : null; } catch {}

        res.json({
            status: row.status === 'processing' ? 'processing' : (result?.status ?? row.status),
            orderid: row.uid,
            created: row.created,
            updated: row.updated,
            result,
        });
    } catch (e) {
        console.error('status error:', e);
        res.status(500).json({ status: 'error', error: 'Internal error' });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'ok', endpoints: ['POST /topup-sync', 'POST /topup', 'GET /status/:orderid'] });
});

require('./cron');

app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
