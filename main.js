import { Actor } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
const {
    name          = '',
    soid          = '',
    serial        = '',
    mode          = 'Inquiry',
    proxyUsername = '',
    proxyPassword = '',
    proxyList     = [],
} = input || {};

const proxyUrls = proxyList.map(p => `http://${proxyUsername}:${proxyPassword}@${p}`);

const INQUIRY_URL = [
    'http://inmate-search.cobbsheriff.org/inquiry.asp',
    `?soid=${encodeURIComponent(soid)}`,
    `&inmate_name=${encodeURIComponent(name)}`,
    `&serial=${encodeURIComponent(serial)}`,
    `&qry=${encodeURIComponent(mode)}`,
].join('');

console.log(`Searching → name="${name}"  mode="${mode}"`);

function parseTableToObject(rows) {
    const obj = {};
    for (const cells of rows) {
        if (cells.length >= 2) {
            const key = cells[0].replace(/:$/, '').trim();
            const val = cells.slice(1).join(' ').trim();
            if (key && val) obj[key] = val;
        } else if (cells.length === 1 && cells[0]) {
            obj['_note'] = (obj['_note'] ? obj['_note'] + ' | ' : '') + cells[0];
        }
    }
    return obj;
}

function isReleased(record) {
    if (record.releaseDate && record.releaseDate.trim().length > 0) return true;
    const status = (record.inmateStatus || '').toLowerCase();
    if (/released|discharge|transferr|out of custody|bonded out|posted bond/i.test(status)) return true;
    if (/in custody|current|active/i.test(status)) return false;
    const rawValues = Object.values(record._raw || {}).join(' ').toLowerCase();
    if (/released|discharge|bonded out|transferr/i.test(rawValues)) return true;
    return false;
}

function buildStructuredRecord(rawMap, sourceUrl) {
    const find = (...keys) => {
        for (const k of keys) {
            const match = Object.entries(rawMap).find(([label]) =>
                label.toLowerCase().includes(k.toLowerCase())
            );
            if (match) return match[1];
        }
        return null;
    };

    const chargeRows = Object.entries(rawMap)
        .filter(([k]) => /charge|offense|statute/i.test(k))
        .map(([label, value]) => ({ label, value }));

    return {
        name             : find('name', 'inmate'),
        soid             : find('soid', 'id'),
        dob              : find('birth', 'dob', 'date of birth'),
        race             : find('race'),
        sex              : find('sex', 'gender'),
        height           : find('height'),
        weight           : find('weight'),
        hair             : find('hair'),
        eyes             : find('eye'),
        bookingNumber    : find('booking number', 'booking #', 'book no'),
        bookingDate      : find('booking date', 'booked', 'arrest date'),
        arrestingAgency  : find('arresting agency', 'agency'),
        arrestDate       : find('arrest date'),
        facility         : find('facility', 'location', 'housing'),
        inmateStatus     : find('status', 'custody', 'in custody'),
        releaseDate      : find('release date', 'released'),
        releaseReason    : find('release reason', 'reason'),
        bondAmount       : find('bond amount', 'bond', 'bail'),
        bondType         : find('bond type'),
        charges          : chargeRows.length > 0 ? chargeRows : find('charge', 'offense'),
        sourceUrl,
        scrapedAt        : new Date().toISOString(),
        _raw             : rawMap,
    };
}

async function scrapeTableRows(page) {
    return page.evaluate(() => {
        const rows = [];
        document.querySelectorAll('table tr').forEach(tr => {
            const cells = Array.from(tr.querySelectorAll('td, th'))
                .map(td => td.innerText?.trim().replace(/\s+/g, ' ') || '');
            if (cells.some(c => c.length > 0)) rows.push(cells);
        });
        return rows;
    });
}

const results = [];

const proxyConfiguration = proxyUrls.length > 0
    ? new ProxyConfiguration({ proxyUrls })
    : undefined;

const crawler = new PlaywrightCrawler({

    ...(proxyConfiguration ? { proxyConfiguration } : {}),

    launchContext: {
        launchOptions: {
            headless : true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.setExtraHTTPHeaders({
                'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language' : 'en-US,en;q=0.9',
            });
            await page.route('**/*.{png,jpg,jpeg,gif,svg,ico,woff,woff2,ttf,css}', route => route.abort());
        },
    ],

    requestHandlerTimeoutSecs : 300,
    navigationTimeoutSecs     : 120,
    maxRequestRetries         : 3,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForSelector('body', { timeout: 60000 });
        const pageText = (await page.textContent('body')) || '';

        if (/no record/i.test(pageText) || /not found/i.test(pageText)) {
            log.info('No inmate record found.');
            results.push({ found: false, name, mode, scrapedAt: new Date().toISOString() });
            return;
        }

        const detailUrls = await page.evaluate(() => {
            const captured = [];
            const originalOpen = window.open;
            window.open = (url) => { captured.push(url); return null; };
            const buttons = Array.from(document.querySelectorAll('button, input[type="button"], a'));
            for (const btn of buttons) {
                const text = (btn.innerText || btn.value || btn.textContent || '').toLowerCase();
                if (/booking|detail|last|view|inquiry/i.test(text)) btn.click();
            }
            window.open = originalOpen;
            return captured;
        });

        const html = await page.content();
        const htmlMatches = [...html.matchAll(/InmDetails\.asp\?[^"'<>\s]+/g)]
            .map(m => m[0].replace(/&amp;/g, '&'));

        const base = 'http://inmate-search.cobbsheriff.org/';
        const allDetailUrls = [...new Set([...detailUrls, ...htmlMatches])]
            .map(u => u.startsWith('http') ? u : base + u);

        log.info(`Found ${allDetailUrls.length} detail URL(s)`);

        if (allDetailUrls.length === 0) {
            log.warning('No detail URLs found — scraping current page as-is');
            const rows = await scrapeTableRows(page);
            const rawMap = parseTableToObject(rows);
            const record = buildStructuredRecord(rawMap, page.url());
            if (!isReleased(record)) {
                log.info('⏭  Skipping — inmate still in custody');
                return;
            }
            results.push({ found: true, ...record });
            return;
        }

        for (const detailUrl of allDetailUrls) {
            log.info(`Navigating to detail: ${detailUrl}`);
            try {
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
                await page.waitForSelector('table', { timeout: 30000 }).catch(() => {});

                const rows   = await scrapeTableRows(page);
                const rawMap = parseTableToObject(rows);
                const record = buildStructuredRecord(rawMap, page.url());
                const released = isReleased(record);

                log.info(`✅ Parsed: ${record.name || '(unknown)'} | released=${released}`);

                if (!released) {
                    log.info('⏭  Skipping — inmate still in custody');
                    continue;
                }

                results.push({ found: true, ...record });

            } catch (err) {
                log.error(`Failed to load ${detailUrl}: ${err.message}`);
                results.push({ found: false, error: err.message, sourceUrl: detailUrl, scrapedAt: new Date().toISOString() });
            }
        }
    },

    failedRequestHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url} — ${error?.message}`);
        results.push({ found: false, error: error?.message, sourceUrl: request.url, scrapedAt: new Date().toISOString() });
    },
});

await crawler.run([{ url: INQUIRY_URL }]);

for (const record of results) {
    await Actor.pushData(record);
}

const released = results.filter(r => r.found);
console.log(`Done. Released inmates: ${released.length} found (in-custody records skipped).`);

await Actor.exit();
