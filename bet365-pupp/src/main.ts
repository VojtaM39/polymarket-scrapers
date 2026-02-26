import { PuppeteerCrawler } from "@crawlee/puppeteer";
import { Actor, log } from "apify";

import { router } from "./routes.js";

interface Input {
	url: string;
}

await Actor.init();

const { url = "https://www.bet365.com/#/IP/EV151304775475C13" } =
	(await Actor.getInput<Input>()) ?? ({} as Input);

log.info("Starting bet365 WS interceptor", { url });

const proxyConfiguration = await Actor.createProxyConfiguration({
	groups: ["RESIDENTIAL"],
    countryCode: "US",
});

const crawler = new PuppeteerCrawler({
    headless: false,
	proxyConfiguration,
	requestHandlerTimeoutSecs: 99999,
	navigationTimeoutSecs: 30,
    sessionPoolOptions: { sessionOptions: { maxErrorScore: 0 } },
	maxRequestRetries: 20,
	preNavigationHooks: [
		async ({ page }) => {
			page.on("websocket", (ws) => {
				const wsUrl = ws.url();
				if (!wsUrl.includes("premws-pt5.365lpodds.com")) return;

				log.info("WebSocket opened", { url: wsUrl });

				ws.on("framereceived", (frame) => {
					log.info("WS message received", { data: String(frame.payload) });
				});

				ws.on("framesent", (frame) => {
					log.info("WS message sent", { data: String(frame.payload) });
				});

				ws.on("close", () => log.info("WebSocket closed", { url: wsUrl }));
			});
		},
	],
	requestHandler: async ({ log: handlerLog }) => {
		handlerLog.info("Page loaded, waiting for WS messages...");
		await new Promise((r) => setTimeout(r, 99_999_000));
		handlerLog.info("Done waiting");
	},

	launchContext: {
		launchOptions: {
			args: [
				"--disable-gpu", // Mitigates the "crashing GPU process" issue in Docker containers
				"--no-sandbox", // Mitigates the "sandboxed" process issue in Docker containers
			],
		},
	},
});

await crawler.run([url]);

await Actor.exit();
