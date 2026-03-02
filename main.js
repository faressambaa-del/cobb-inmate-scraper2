
cat > /home/claude/scraper/ccobb-inmate-scraper-improved/main.js << 'ENDOFFILE'
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function buildStructuredRecord(rawMap, sourceUrl, listingReleased) {
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
        name            : find('name', 'inmate'),
        soid            : find('soid', 'id'),
        dob             : find('birth', 'dob', 'date of birth'),
        race            : find('race'),
        sex             : find('sex', 'gender'),
        height          : find('height'),
        weight          : find('weight'),
        hair            : find('hair'),
        eyes            : find('eye'),
        bookingNumber   : find('booking number', 'booking #', 'book no'),
        bookingDate     : find('booking date', 'booked', 'arrest date'),
        arrestingAgency : find('arresting agency', 'agency'),
        arrestDate      : find('arrest date'),
        facility        : find('facility', 'location', 'housing'),
        inmateStatus    : listingReleased ? 'RELEASED' : find('status', 'custody', 'in custody'),
        releaseDate     : find('release date', 'released'),
        releaseReason   : find('release reason', 'reason'),
        bondAmount      : find('bond amount', 'bond', 'bail'),
        bondType        : find('bond type'),
        charges         : chargeRows.length > 0 ? chargeRows : find('charge', 'offense'),
        sourceUrl,
        scrapedAt       : new Date().toISOString(),
        _raw            : rawMap,
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

// ── Crawler ───────────────────────────────────────────────────────────────────

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
            // Only block images — keep CSS/JS so buttons and tables render correctly
            await page.route('**/*.{png,jpg,jpeg,gif,ico}', route => route.abort());
        },
    ],

    requestHandlerTimeoutSecs : 300,
    navigationTimeoutSecs     : 120,
    maxRequestRetries         : 3,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForSelector('body', { timeout: 60000 });

        // Log the raw HTML so we can see exactly what the page returned
        const html = await page.content();
        log.info(`Page HTML snippet: ${html.substring(0, 2000)}`);

        const pageText = (await page.textContent('body')) || '';
        log.info(`Page text snippet: ${pageText.substring(0, 500)}`);

        // ── No results check ──────────────────────────────────────────────────
        if (/no record/i.test(pageText) || /not found/i.test(pageText)) {
            log.info('No inmate record found on this page.');
            results.push({ found: false, name, mode, scrapedAt: new Date().toISOString() });
            return;
        }

        // ── Extract detail URLs + release status directly from HTML ───────────
        // Parse the raw HTML to find InmDetails URLs and pair each with whether
        // its table row contains the word "RELEASED"
        const base = 'http://inmate-search.cobbsheriff.org/';

        const entries = await page.evaluate((baseUrl) => {
            const results = [];

            // Walk each table row
            document.querySelectorAll('table tr').forEach(tr => {
                const rowHtml = tr.innerHTML || '';
                const rowText = tr.innerText || '';

                // Look for InmDetails URL in this row's HTML
                const urlMatch = rowHtml.match(/InmDetails\.asp\?[^"'<>\s]+/);
                if (!urlMatch) return;

                const rawUrl = urlMatch[0].replace(/&amp;/g, '&');
                const fullUrl = rawUrl.startsWith('http') ? rawUrl : baseUrl + rawUrl;
                const isReleased = /released/i.test(rowText);

                results.push({ url: fullUrl, releasedOnListing: isReleased });
            });

            // Also check onclick attributes on buttons/inputs for sh() calls
            document.querySelectorAll('button, input[type="button"]').forEach(btn => {
                const onclick = btn.getAttribute('onclick') || '';
                const match = onclick.match(/InmDetails\.asp\?[^"'<>\s)]+/);
                if (!match) return;

                const rawUrl = match[0].replace(/&amp;/g, '&');
                const fullUrl = rawUrl.startsWith('http') ? rawUrl : baseUrl + rawUrl;

                // Check if already captured
                if (!results.find(r => r.url === fullUrl)) {
                    const rowText = btn.closest('tr')?.innerText || '';
                    results.push({ url: fullUrl, releasedOnListing: /released/i.test(rowText) });
                }
            });

            return results;
        }, base);

        log.info(`Extracted entries from HTML: ${JSON.stringify(entries)}`);

        // ── If still nothing found, log full HTML for debugging ───────────────
        if (entries.length === 0) {
            log.warning(`Could not find any InmDetails URLs. Full HTML: ${html}`);
            results.push({ found: false, name, mode, scrapedAt: new Date().toISOString(), debugHtml: html.substring(0, 5000) });
            return;
        }

        // ── Visit each released inmate's detail page ──────────────────────────
        for (const entry of entries) {
            const { url: detailUrl, releasedOnListing } = entry;

            log.info(`Entry: ${detailUrl} | releasedOnListing=${releasedOnListing}`);

            if (!releasedOnListing) {
                log.info(`Skipping — listing shows in custody`);
                continue;
            }

            log.info(`Navigating to detail page: ${detailUrl}`);
            try {
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
                await page.waitForSelector('table', { timeout: 30000 }).catch(() => {});

                const rows   = await scrapeTableRows(page);
                const rawMap = parseTableToObject(rows);
                const record = buildStructuredRecord(rawMap, page.url(), releasedOnListing);

                log.info(`✅ Scraped released inmate: ${record.name || '(unknown)'}`);
                results.push({ found: true, ...record });

            } catch (err) {
                log.error(`Failed to load ${detailUrl}: ${err.message}`);
                results.push({
                    found     : false,
                    error     : err.message,
                    sourceUrl : detailUrl,
                    scrapedAt : new Date().toISOString(),
                });
            }
        }
    },

    failedRequestHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url} — ${error?.message}`);
        results.push({
            found     : false,
            error     : error?.message,
            sourceUrl : request.url,
            scrapedAt : new Date().toISOString(),
        });
    },
});

await crawler.run([{ url: INQUIRY_URL }]);

for (const record of results) {
    await Actor.pushData(record);
}

const released = results.filter(r => r.found);
console.log(`Done. Released inmates: ${released.length} found.`);

await Actor.exit();
ENDOFFILE
echo "Done"
Output

Done
