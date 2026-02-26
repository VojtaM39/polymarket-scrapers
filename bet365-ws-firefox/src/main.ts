import { PlaywrightCrawler } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';

interface Input {
    url: string;
}

await Actor.init();

const { url = 'https://www.bet365.com/#/IP/EV151304775475C13' } =
    (await Actor.getInput<Input>()) ?? ({} as Input);

log.info('Starting bet365 WS interceptor', { url });

const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL']
});


const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    launchContext: {
        launcher: firefox,
        launchOptions: await camoufoxLaunchOptions({
            headless: true,
            proxy: await proxyConfiguration?.newUrl(),
            geoip: true,
        }),
    },
    requestHandlerTimeoutSecs: 99999,
    navigationTimeoutSecs: 30,
    preNavigationHooks: [
        async ({ page }) => {
            // Neutralize Bet365's console.table() crash attack on Firefox
            await page.addInitScript(() => {
                const noop = () => {};
                console.table = noop;
                console.log = noop;
                console.warn = noop;
                console.error = noop;
                console.info = noop;
                console.debug = noop;
                console.dir = noop;
                console.dirxml = noop;
                console.clear = noop;
            });

            page.on('websocket', (ws) => {
                const wsUrl = ws.url();
                if (!wsUrl.includes('premws-pt5.365lpodds.com')) return;

                log.info('WebSocket opened', { url: wsUrl });

                ws.on('framereceived', (frame) => {
                    log.info('WS message received', { data: String(frame.payload) });
                });

                ws.on('framesent', (frame) => {
                    log.info('WS message sent', { data: String(frame.payload) });
                });

                ws.on('close', () => log.info('WebSocket closed', { url: wsUrl }));
            });
        },
    ],
    requestHandler: async ({ page, log: handlerLog }) => {
        handlerLog.info('Page loaded, waiting for WS messages...');
        // Wait to collect WebSocket messages
        await page.waitForTimeout(99999_000);
        handlerLog.info('Done waiting');
    },
});

await crawler.run([url]);

// Exit successfully
await Actor.exit();
