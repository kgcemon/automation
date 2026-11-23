/**
 * One shared, real Google Chrome instance for the whole app.
 *
 * - Uses the Chrome installed on the machine, started as a NORMAL Chrome (no
 *   automation switches) and attached over the DevTools port. Can also attach to a
 *   Chrome you started yourself (see npm run chrome).
 * - Persistent profile (CHROME_PROFILE_DIR) so cookies / site trust survive restarts,
 *   and a human-solved captcha keeps working for later jobs
 * - Every job gets its own tab which is always closed afterwards
 * - Images / media / fonts are blocked to keep CPU, RAM and bandwidth low
 * - A Chrome we own is recycled after BROWSER_MAX_JOBS jobs to avoid memory creep
 */
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const puppeteer = require('puppeteer');
const log = require('./logger');

const HEADLESS = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
const PROFILE_DIR = path.resolve(process.env.CHROME_PROFILE_DIR || './chrome-profile');
const MAX_JOBS = Number(process.env.BROWSER_MAX_JOBS || 50);
const BLOCK_ASSETS = String(process.env.BLOCK_ASSETS || 'true').toLowerCase() === 'true';
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const DEBUG_URL = process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9222';
// true = Chrome keeps running when the server stops/restarts (cookies & trust stay warm)
const KEEP_CHROME_OPEN = String(process.env.KEEP_CHROME_OPEN || 'true').toLowerCase() === 'true';

let browser = null;
let launching = null;
let jobsServed = 0;
let activeTabs = 0;
let chromeProcess = null; // set only when this process owns Chrome's lifetime

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const candidates = {
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ],
        linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
        darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    }[process.platform] || [];
    const found = candidates.find(p => p && fs.existsSync(p));
    if (!found) throw new Error('Google Chrome not found. Install Chrome or set CHROME_PATH in .env');
    return found;
}

async function tryConnect() {
    try {
        return await puppeteer.connect({ browserURL: DEBUG_URL, defaultViewport: null });
    } catch {
        return null;
    }
}

/**
 * Start Chrome as a normal app (like double-clicking it), NOT via puppeteer.launch().
 * puppeteer.launch() adds automation switches (--enable-automation etc.), which is
 * exactly what makes the shop ask for verification. We then just attach over the
 * DevTools port, the same way as attaching to your own Chrome.
 */
async function startChrome() {
    const executablePath = findChrome();
    const port = new URL(DEBUG_URL).port || '9222';
    log.info(`Starting Chrome (${HEADLESS ? 'headless' : 'visible'}) profile=${PROFILE_DIR} port=${port}`);
    const child = spawn(executablePath, [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',          // avoids /dev/shm crashes on small VPS
        '--window-size=1280,900',
        ...(HEADLESS ? ['--headless=new'] : []),
        ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        'about:blank',
    ], { detached: KEEP_CHROME_OPEN, stdio: 'ignore' });
    if (KEEP_CHROME_OPEN) child.unref();
    else chromeProcess = child;

    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        const b = await tryConnect();
        if (b) return b;
    }
    throw new Error(`Chrome did not open DevTools port ${port}`);
}

async function launch() {
    // 1) Attach to a Chrome that is already running (yours, or one we started earlier)
    let b = await tryConnect();
    if (b) log.info(`Attached to running Chrome at ${DEBUG_URL}`);
    // 2) Otherwise start a normal Chrome ourselves and attach
    else b = await startChrome();

    b.on('disconnected', () => {
        if (browser === b) {
            log.warn('Chrome disconnected');
            browser = null;
        }
    });
    jobsServed = 0;
    return b;
}

async function getBrowser() {
    // Recycle when idle and past the job budget
    if (browser && chromeProcess && jobsServed >= MAX_JOBS && activeTabs === 0) {
        log.info(`Recycling Chrome after ${jobsServed} jobs`);
        const old = browser;
        browser = null;
        await old.close().catch(() => {});
        chromeProcess = null;
    }
    if (browser && browser.connected) return browser;
    if (!launching) {
        launching = launch()
            .then(b => (browser = b))
            .finally(() => { launching = null; });
    }
    return launching;
}

/**
 * Opens a fresh tab, runs fn(page), and always closes the tab.
 */
async function withPage(fn) {
    const b = await getBrowser();
    const page = await b.newPage();
    activeTabs++;
    try {
        page.setDefaultTimeout(Number(process.env.STEP_TIMEOUT_MS || 30000));
        page.setDefaultNavigationTimeout(60000);
        if (BLOCK_ASSETS) {
            await page.setRequestInterception(true);
            page.on('request', req => {
                if (req.isInterceptResolutionHandled()) return;
                if (BLOCKED_TYPES.has(req.resourceType())) req.abort().catch(() => {});
                else req.continue().catch(() => {});
            });
        }
        return await fn(page);
    } finally {
        activeTabs--;
        jobsServed++;
        await page.close().catch(() => {});
    }
}

/** Stop using Chrome. Only kills it if this process owns it; otherwise just detaches. */
async function closeBrowser() {
    const b = browser;
    browser = null;
    if (!b) return;
    if (chromeProcess) {
        await b.close().catch(() => {});
        chromeProcess = null;
    } else {
        await b.disconnect().catch(() => {});
    }
}

module.exports = { withPage, getBrowser, closeBrowser, findChrome, HEADLESS, PROFILE_DIR, DEBUG_URL };
