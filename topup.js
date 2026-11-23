const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');

puppeteer.use(StealthPlugin());

async function runAutomation(url, denom, type, voucherCode, callback) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true, // Set to true for production
            executablePath: executablePath(),
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.goto(url, { timeout: 60000, waitUntil: 'networkidle2' });

        // Wait for and select payment denomination
        await page.waitForSelector('.payment-denom-button');
        const buttons = await page.$$('.payment-denom-button');
        if (buttons.length >= 10) {
            await buttons[denom].click();
        } else {
            throw new Error('Payment denomination buttons not found.');
        }

        await page.waitForNavigation();

        // Expand the dropdown
        const expandBTN = '.icon-Expand-More';
        await page.waitForSelector(expandBTN);
        await page.click(expandBTN);

        // Select payment type
        const typeBTN = type === 1 ? '#pc_div_659' : '#pc_div_670';
        await page.waitForSelector(typeBTN, { visible: true });
        await page.click(typeBTN);

        // Wait for serial input
        try {
            await page.waitForSelector('#serial', { timeout: 1000 });
        } catch {
            await page.waitForNavigation().catch(() => {});
            await page.waitForSelector('#serial');
        }

        // Enter voucher code
        await page.type('#serial', voucherCode, { delay: 100 });
        await page.click('[type=submit]');

        // Check for invalid voucher
        try {
            const isInvalid = await page.evaluate(() => {
                return document.querySelectorAll('[aria-invalid="false"]').length > 0;
            });

            if (isInvalid) {
                await browser.close();
                return callback({ message: 'Invalid Voucher Code.' }, null);
            }
        } catch {}

        // Check for validation error
        const validationError = await page.evaluate(() => {
            const errorElement = document.querySelector('.validationError .alert.alert-danger');
            return errorElement ? errorElement.textContent.trim() : null;
        });

        if (validationError) {
            await browser.close();
            return callback({ error: 'Validation Error', message: validationError }, null);
        }

        // Check the final URL for success or failure
        const currentUrl = page.url();
        if (currentUrl.includes('https://www.unipin.com/unibox/error/')) {
            const errorMessage = decodeURIComponent(currentUrl.split('/').pop());
            await browser.close();
            return callback({ message: errorMessage === 'Consumed Voucher' ? 'The voucher has already been used.' : errorMessage }, null);
        }

        if (currentUrl.includes('https://www.unipin.com/unibox/result/')) {
            await browser.close();
            return callback(null, { message: currentUrl });
        }

        // Default error response if URL does not match expected patterns
        await browser.close();
        return callback({ message: 'Unknown error occurred.' }, null);

    } catch (error) {
        if (browser) await browser.close();
        console.error('Transaction Failed:', error);
        return callback({ error: 'Error', message: 'Transaction Failed' }, null);
    }
}

module.exports = { runAutomation };
