/**
 * One shared, real Google Chrome instance for the whole app.
 *
 * - Uses the Chrome installed on the machine, started as a NORMAL Chrome (no
 *   automation switches) and attached over the DevTools port. Can also attach to a
 *   Chrome you started yourself (see npm run chrome).
 * - Persistent profile (CHROME_PROFILE_DIR) so cookies / site trust survive restarts,
 *   and a human-solved captcha keeps working for later jobs
 * - Every job gets its own tab which is always closed afterwards
 * - Pages load normally (images included); BLOCK_ASSETS=true to save bandwidth
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
const BLOCK_ASSETS = String(process.env.BLOCK_ASSETS || 'false').toLowerCase() === 'true';
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
    if (process.env.CHROME_PATH) {
        if (fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
        throw new Error(`Google Chrome not found at CHROME_PATH=${process.env.CHROME_PATH}. Fix the path in .env or leave it empty to auto-detect`);
    }
    const candidates = {
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ],
        linux: [
            '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
            // Fallbacks if only Chromium is installed (real Google Chrome is preferred)
            '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
        ],
        darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    }[process.platform] || [];
    // Also look anywhere on PATH (e.g. installed to /usr/local/bin)
    if (process.platform !== 'win32') {
        const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
        for (const dir of (process.env.PATH || '').split(path.delimiter)) {
            for (const n of names) candidates.push(path.join(dir, n));
        }
    }
    const found = candidates.find(p => p && fs.existsSync(p));
    if (!found) {
        const hint = process.platform === 'linux'
            ? ' (Ubuntu/Debian: wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb)'
            : '';
        throw new Error(`Google Chrome not found. Install Chrome or set CHROME_PATH in .env${hint}`);
    }
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
/**
 * Linux VPS has no screen. A visible Chrome needs one, so start a long-lived
 * virtual screen (Xvfb) that outlives this process, just like Chrome does.
 * Connect a VNC viewer to it (x11vnc -display :99) to solve a captcha by hand.
 */
function ensureDisplay() {
    if (process.platform !== 'linux' || HEADLESS || process.env.DISPLAY) return;
    const display = process.env.XVFB_DISPLAY || ':99';
    if (!fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) {
        log.info(`No DISPLAY - starting Xvfb on ${display}`);
        try {
            spawn('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], { detached: true, stdio: 'ignore' })
                .on('error', e => log.error(`Xvfb failed (apt install xvfb): ${e.message}`))
                .unref();
        } catch (e) {
            log.error(`Xvfb failed (apt install xvfb): ${e.message}`);
        }
    }
    process.env.DISPLAY = display;
}

async function startChrome() {
    const executablePath = findChrome();
    ensureDisplay();
    if (process.platform === 'linux' && !HEADLESS) await new Promise(r => setTimeout(r, 1000));
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
