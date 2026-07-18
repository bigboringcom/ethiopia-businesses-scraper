import { PlaywrightCrawler, log } from 'crawlee';
import { Actor } from 'apify';

await Actor.init();

const input = await Actor.getInput() || {};
const maxItems = input.maxItems || 500;
const maxRunTimeMinutes = input.maxRunTimeMinutes || 5;

const START_URLS = [
    'https://ethiopia.africa-places.com/category/hospitals-in-ethiopia',
    'https://ethiopia.africa-places.com/category/hotels-in-ethiopia',
    'https://ethiopia.africa-places.com/category/restaurants-in-ethiopia',
    'https://ethiopia.africa-places.com/category/banks-in-ethiopia',
    'https://ethiopia.africa-places.com/area/addis-ababa-ethiopia-1',
];

const NOISE = ['login', 'register', 'add listing', 'contact', 'privacy', 'terms', 'about', 'report', 'home', 'africa-places', 'explore', 'top areas', 'categories'];
let totalItems = 0;

const proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] });

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestRetries: 2,
    maxConcurrency: 2,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    headless: true,

    async requestHandler({ page, request }) {
        if (totalItems >= maxItems) return;

        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(3000);

        const isDetailPage = request.userData.type === 'detail' || request.url.includes('/places/');

        if (isDetailPage) {
            log.info(`Detail: ${request.url}`);

            const data = await page.evaluate(() => {
                let name = '';
                const h1 = document.querySelector('h1');
                if (h1) name = h1.textContent.trim();
                if (!name) name = document.title.replace(/\s*[-|–].*$/, '').trim();

                let phone = '';
                document.querySelectorAll('a[href^="tel:"]').forEach(el => {
                    const p = el.getAttribute('href').replace('tel:', '').trim();
                    if (p.replace(/\D/g, '').length >= 8 && !phone) phone = p;
                });
                // Also look for phone in text
                if (!phone) {
                    const bodyText = document.body.textContent;
                    const m = bodyText.match(/(?:\+251|0)\s?\d{2}[\s-]?\d{3}[\s-]?\d{4}/);
                    if (m) phone = m[0].trim();
                }

                let address = '';
                // africa-places shows address near the name
                const addrEl = document.querySelector('[class*="address"], [itemprop="address"]');
                if (addrEl) address = addrEl.textContent.trim();
                if (!address) {
                    const bodyText = document.body.textContent;
                    const m = bodyText.match(/([A-Z][^,]+(?:Road|Rd|Street|St|Avenue|Ave|Drive|Dr)[^,]*,\s*[A-Za-z\s]+,?\s*Ethiopia)/i);
                    if (m) address = m[1].trim();
                }

                let category = '';
                document.querySelectorAll('a[href*="/category/"]').forEach(el => {
                    const t = el.textContent.trim();
                    if (t.length > 2 && t.length < 50 && !category) category = t;
                });

                let rating = '';
                const ratingEl = document.querySelector('[class*="rating"], [itemprop="ratingValue"]');
                if (ratingEl) rating = ratingEl.textContent.trim();

                let website = '';
                document.querySelectorAll('a[href^="http"]').forEach(el => {
                    const href = el.getAttribute('href');
                    if (href && !href.includes('africa-places.com') && !href.includes('facebook') && !href.includes('google') && !href.includes('twitter') && !website) {
                        website = href;
                    }
                });

                return { name, phone, address, category, rating, website };
            });

            if (!data.name || data.name.length < 3) return;

            await Actor.pushData({
                name: data.name,
                phone: data.phone || 'Not Found',
                address: data.address || 'Not Found',
                website: data.website || 'Not Found',
                category: data.category || 'Business',
                rating: data.rating || '',
                sourceUrl: request.url,
            });
            totalItems++;
            log.info(`✅ ${data.name} | ${data.phone || 'no phone'}`);
            return;
        }

        // LISTING PAGE
        log.info(`Listing: ${request.url}`);

        const detailLinks = await page.evaluate((noise) => {
            const links = [];
            document.querySelectorAll('a[href*="/places/"]').forEach(a => {
                const href = a.getAttribute('href');
                const text = a.textContent.trim().replace(/\s+/g, ' ');
                if (!href || text.length < 3 || text.length > 120) return;
                if (noise.some(n => text.toLowerCase().includes(n))) return;
                if (href.includes('/places/') && !links.find(l => l.url === href)) {
                    links.push({ url: href.startsWith('http') ? href : `https://ethiopia.africa-places.com${href}`, name: text });
                }
            });
            return links.slice(0, 30);
        }, NOISE);

        for (const link of detailLinks) {
            if (totalItems >= maxItems) break;
            await crawler.addRequests([{ url: link.url, userData: { type: 'detail', name: link.name } }]);
        }
        log.info(`Enqueued ${detailLinks.length} detail pages from ${request.url}`);

        // Pagination
        if (totalItems < maxItems) {
            const nextLinks = await page.evaluate(() => {
                const links = [];
                document.querySelectorAll('a[href*="/category/"], a[href*="/area/"]').forEach(a => {
                    const href = a.getAttribute('href');
                    if (href && href.startsWith('http') && !links.includes(href)) links.push(href);
                });
                return links.slice(0, 5);
            });
            for (const url of nextLinks) await crawler.addRequests([{ url }]);
        }
    },
});

setTimeout(() => { log.warning(`Max run time ${maxRunTimeMinutes}m reached.`); crawler.teardown(); }, maxRunTimeMinutes * 60 * 1000);
log.info('Starting Ethiopia Businesses Scraper (africa-places.com)...');
await crawler.run(START_URLS);
log.info(`🎉 Done. Total: ${totalItems}`);
await Actor.exit();
