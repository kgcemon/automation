/**
 * UniPin step: on the payment URL, pick the denomination, choose the voucher
 * payment method, enter the voucher code and read the result.
 * Runs in the same Chrome tab used for the shop login.
 */
const log = require('./logger');

const PAYMENT_SELECTORS = {
    1: process.env.PAYMENT_SELECTOR_1 || '#pc_div_659',
    2: process.env.PAYMENT_SELECTOR_2 || '#pc_div_670',
};

class TopupError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

async function redeemVoucher(page, url, { denom, type, voucherCode, paymentSelector }) {
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Denomination
    await page.waitForSelector('.payment-denom-button');
    const buttons = await page.$$('.payment-denom-button');
    if (denom < 0 || denom >= buttons.length) {
        throw new TopupError(`Denomination index ${denom} out of range (found ${buttons.length} options)`, 'DENOM');
    }
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), buttons[denom].click()]);

    // Payment method
    await page.waitForSelector('.icon-Expand-More');
    await page.click('.icon-Expand-More');
    const typeBTN = paymentSelector || PAYMENT_SELECTORS[Number(type)] || PAYMENT_SELECTORS[2];
    await page.waitForSelector(typeBTN, { visible: true });
    await page.click(typeBTN);

    // Voucher
    await page.waitForSelector('#serial', { visible: true });
    await page.type('#serial', voucherCode, { delay: 70 });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {}),
        page.click('[type=submit]'),
    ]);

    const validationError = await page.evaluate(() =>
        document.querySelector('.validationError .alert.alert-danger')?.textContent.trim() || null);
    if (validationError) throw new TopupError(validationError, 'VALIDATION');

    const currentUrl = page.url();
    if (currentUrl.includes('unipin.com/unibox/error/')) {
        const msg = decodeURIComponent(currentUrl.split('/').pop());
        throw new TopupError(msg === 'Consumed Voucher' ? 'The voucher has already been used.' : msg, 'VOUCHER');
    }
    if (currentUrl.includes('unipin.com/unibox/result/')) {
        log.info('Voucher redeemed:', currentUrl);
        return { resultUrl: currentUrl };
    }
    if (await page.$('[aria-invalid="true"]')) throw new TopupError('Invalid Voucher Code.', 'VOUCHER');

    throw new TopupError('Unknown result from UniPin.', 'UNKNOWN');
}

module.exports = { redeemVoucher, TopupError };
