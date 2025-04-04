const express = require("express");
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { paymentLink } = require("./paymentLink");
const { runAutomation } = require("./topup");
const { addTransaction, updateTransaction, findTransaction } = require("./database");
const axios = require("axios");
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;
const SECRET_KEY = process.env.RA_SECRET_KEY;

app.use(express.json());

const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { status: false, message: "Too many requests, please try again later." },
    keyGenerator: (req) => req.header('RA-SECRET-KEY') || req.ip
});

let transactionRunning = false;

app.get('/transactions/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        if (!uid) {
            return res.status(400).json({ status: false, message: 'transaction uid is required' });
        }
        const transactionData = await findTransaction(uid);
        if (!transactionData) {
            return res.status(400).json({ status: false, message: 'Invalid transaction uid' });
        }

        res.status(200).json(transactionData);
    } catch (error) {
        console.error('Error handling transaction find request:', error);
        res.status(500).json({ status: false, message: 'Internal server error' });
    }
});

app.post("/topup", limiter, async (req, res) => {
    const { playerId, denom, type, voucherCode, webhook } = req.body;
    const apiKey = req.header('RA-SECRET-KEY');

    if (!playerId || !denom || !voucherCode || !webhook || !isLinkValid(webhook)) {
        return res.status(400).json({ status: false, message: 'Invalid request parameters' });
    }
    if (!(apiKey === SECRET_KEY)) {
        return res.status(403).json({ status: false, message: 'Invalid Secret Key' });
    }

    const uid = uuidv4();

    try {
        await addTransaction(uid, "processing", "Transaction set to Processing");
    } catch (error) {
        console.error(`Failed to add transaction: ${error}`);
        return res.status(500).json({ status: false, message: 'Failed to start transaction' });
    }

    res.status(200).json({ status: true, message: 'Transaction set to Processing', uid: uid });

    try {
        while (transactionRunning) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        transactionRunning = true;

        const link = await paymentLink(playerId);

        if (!isLinkValid(link)) {
            await notifyWebhook(webhook, uid, { status: false, message: 'Invalid Player ID' });
            return;
        }

        await runAutomation(link, denom, type, voucherCode, async (error, result) => {
            if (error) {
                await notifyWebhook(webhook, uid, { status: false, message: error.message });
            } else {
                await notifyWebhook(webhook, uid, { status: true, message: "Transaction successful", extra: result.message });
            }
        });
    } catch (error) {
        console.error('Error processing top-up:', error);
        await notifyWebhook(webhook, uid, { status: false, message: error.message });
    } finally {
        transactionRunning = false;
    }
});

function isLinkValid(link) {
    return /^https?:\/\//.test(link);
}

async function notifyWebhook(url, uid, payload) {
    if (!url) return;

    payload.uid = uid;

    const status = payload.status ? 'success' : 'failed';

    try {
        await updateTransaction(payload.uid, status, payload.message, payload.extra ?? null);
    } catch (error) {
        console.error(`Failed to update transaction: ${error}`);
    }

    try {
        await axios.post(url, payload);
    } catch (error) {
        console.error(`Failed to notify webhook: ${error.message}`);
    }
}


app.get("/", (req, res) => {
    res.redirect('/');
});

require('./cron');

app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});

