import CDP from "chrome-remote-interface";
import fs from "fs";
import path from "path";
import { TennisStateManager, formatMatchSummary, formatUpdate } from "./parser.js";

type AnyObj = Record<string, any>;

const NAME_FILTER = undefined;

const WS_FILTER = "premws-pt1.us.365lpodds.com";
const LOGS_DIR = path.join(process.cwd(), "logs");
const MATCH_LOGS_DIR = path.join(LOGS_DIR, "matches");

// Tennis state manager - parses WS messages into structured match data
const tennis = new TennisStateManager();

function sanitizeForFilename(s: string): string {
  return s.replace(/[/:?&=.]+/g, "_").replace(/\s+/g, "_").toLowerCase().slice(0, 100);
}

async function main() {
  const port = 9222;

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(MATCH_LOGS_DIR, { recursive: true });

  const version = await CDP.Version({ port });
  const browserWs = (version as any).webSocketDebuggerUrl as string | undefined;
  if (!browserWs) {
    throw new Error("No webSocketDebuggerUrl. Start Chrome with --remote-debugging-port=9222");
  }

  const client = await CDP({ target: browserWs });
  const { Target } = client;

  // Track which requestIds belong to our target socket
  const trackedIds = new Set<string>();
  // requestId -> WriteStream
  const wsStreams = new Map<string, fs.WriteStream>();
  // eventId -> WriteStream for per-match score logs
  const matchStreams = new Map<string, fs.WriteStream>();

  function trackId(requestId: string, url: string) {
    if (!url.includes(WS_FILTER)) return;
    if (trackedIds.has(requestId)) return;
    trackedIds.add(requestId);

    const ts = new Date().toISOString().replace(/:/g, "-");
    const filename = `${sanitizeForFilename(url)}_${ts}.log`;
    const filepath = path.join(LOGS_DIR, filename);
    wsStreams.set(requestId, fs.createWriteStream(filepath, { flags: "a" }));
    console.log("Tracking WS", requestId, "->", filename);
  }

  // Catch-all: pick up requestId<->url mapping from ANY webSocket event that carries a url
  client.on("event", (message: AnyObj) => {
    if (typeof message.method !== "string" || !message.method.startsWith("Network.webSocket")) return;
    const p = message.params;
    if (!p?.requestId) return;

    // Extract URL from whichever field has it
    const url = p.url || p.request?.url || p.response?.url;
    if (url) trackId(p.requestId, url);
  });

  client.on("Network.webSocketFrameReceived", (params: AnyObj, sessionId: string) => {
    if (!trackedIds.has(params.requestId)) return;
    const payload = params.response.payloadData;
    const line = `${new Date().toISOString()} RECV ${payload}\n`;
    wsStreams.get(params.requestId)?.write(line);
    // console.log("WS recv", payload.slice(0, 120));

    // Parse tennis data from incoming messages
    try {
      const updates = tennis.processMessage(payload);
      for (const update of updates) {
        const formatted = formatUpdate(update, NAME_FILTER, false);
        formatted && console.log(formatted);

        // Log score updates to per-match files
        if (update.type === "score") {
          if (!matchStreams.has(update.eventId)) {
            const fname = sanitizeForFilename(update.match.name) + ".log";
            const fpath = path.join(MATCH_LOGS_DIR, fname);
            matchStreams.set(update.eventId, fs.createWriteStream(fpath, { flags: "a" }));
          }
          const server = update.match.serving === 1 ? update.match.player1 : update.match.player2;
          const line = `${new Date().toISOString()}  (serving: ${server}) ${update.changes.join(", ")}\n`;
          matchStreams.get(update.eventId)!.write(line);
        }
      }
    } catch (e) {
      console.error("Parser error:", e);
    }
  });

  client.on("Network.webSocketFrameSent", (params: AnyObj, sessionId: string) => {
    if (!trackedIds.has(params.requestId)) return;
    const payload = params.response.payloadData;
    const line = `${new Date().toISOString()} SENT ${payload}\n`;
    wsStreams.get(params.requestId)?.write(line);
    console.log("WS sent", payload.slice(0, 120));
  });

  client.on("Network.webSocketClosed", (params: AnyObj, sessionId: string) => {
    if (!trackedIds.has(params.requestId)) return;
    console.log("WS closed", params.requestId);
    wsStreams.get(params.requestId)?.end();
    wsStreams.delete(params.requestId);
    trackedIds.delete(params.requestId);
    // Close all per-match log streams
    for (const stream of matchStreams.values()) stream.end();
    matchStreams.clear();
  });

  // When Chrome auto-attaches to a NEW target, enable Network in it
  Target.on("attachedToTarget", async (evt: AnyObj) => {
    const sessionId = evt.sessionId as string;
    try {
      await client.send("Network.enable", {}, sessionId);
    } catch {
      // some targets (e.g. browser) don't support Network
    }
  });

  // Turn on discovery + auto-attach for future targets
  await Target.setDiscoverTargets({ discover: true });
  await Target.setAutoAttach({
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  // Attach to existing targets NOW
  const { targetInfos } = await Target.getTargets();

  const wanted = targetInfos.filter((t: AnyObj) => {
    const type = t.type as string;
    const url = (t.url as string) || "";
    return (
      type === "page" ||
      type === "iframe" ||
      type === "worker" ||
      type === "service_worker" ||
      url.includes("bet365")
    );
  });

  for (const t of wanted) {
    try {
      const { sessionId } = await Target.attachToTarget({
        targetId: t.targetId,
        flatten: true,
      });
      await client.send("Network.enable", {}, sessionId);
    } catch {
      // Some targets can refuse; ignore
    }
  }

  console.log(`Filtering for: ${WS_FILTER}`);
  console.log(`Logs dir: ${LOGS_DIR}`);
  console.log("Refresh bet365 now.");

  // Periodically log a summary of all live tennis matches
  /*
  setInterval(() => {
    const live = tennis.getLiveMatches();
    if (live.length === 0) return;
    console.log(`\n── Live Tennis (${live.length} matches) ──`);
    for (const m of live) {
      console.log(`  ${formatMatchSummary(m)}`);
    }
    console.log("");
  }, 30_000);
  */

  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
