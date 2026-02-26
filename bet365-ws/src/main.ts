import CDP from "chrome-remote-interface";
import fs from "fs";
import path from "path";
import { StateManager, formatMatchSummary, formatUpdate, SPORT_REGISTRY } from "./parser.js";

type AnyObj = Record<string, any>;

const NAME_FILTER = undefined;

const WS_FILTER = "premws-pt1.us.365lpodds.com";
const SAVE_RAW_LOGS = true;
const LOGS_DIR = path.join(process.cwd(), "logs");
const MATCH_LOGS_DIR = path.join(LOGS_DIR, "matches");

// Multi-sport state manager - parses WS messages into structured match data
const stateManager = new StateManager();

function sanitizeForFilename(s: string): string {
  return s.replace(/[/:?&=.]+/g, "_").replace(/\s+/g, "_").toLowerCase().slice(0, 100);
}

async function main() {
  const port = 9222;

  if (SAVE_RAW_LOGS) fs.mkdirSync(LOGS_DIR, { recursive: true });
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

    if (SAVE_RAW_LOGS) {
      const ts = new Date().toISOString().replace(/:/g, "-");
      const filename = `${sanitizeForFilename(url)}_${ts}.log`;
      const filepath = path.join(LOGS_DIR, filename);
      wsStreams.set(requestId, fs.createWriteStream(filepath, { flags: "a" }));
      console.log("Tracking WS", requestId, "->", filename);
    }
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
    if (SAVE_RAW_LOGS) {
      const line = `${new Date().toISOString()} RECV ${payload}\n`;
      wsStreams.get(params.requestId)?.write(line);
    }

    // Parse match data from incoming messages
    try {
      const rawUpdates = stateManager.processMessage(payload);

      // Merge odds updates by eventId so one match = one log line
      const updates: typeof rawUpdates = [];
      const oddsMap = new Map<string, (typeof rawUpdates)[0]>();
      for (const u of rawUpdates) {
        if (u.type === "odds") {
          const existing = oddsMap.get(u.eventId);
          if (existing) {
            existing.changes.push(...u.changes);
          } else {
            oddsMap.set(u.eventId, u);
            updates.push(u);
          }
        } else {
          updates.push(u);
        }
      }

      for (const update of updates) {
        const formatted = formatUpdate(update, NAME_FILTER, false);
        formatted && console.log(formatted);

        // Log score and odds updates to per-match files
        if (update.type === "score" || update.type === "odds") {
          if (!matchStreams.has(update.eventId)) {
            const sportFolder = SPORT_REGISTRY[update.match.sportId]?.folder || `sport-${update.match.sportId}`;
            const sportDir = path.join(MATCH_LOGS_DIR, sportFolder);
            fs.mkdirSync(sportDir, { recursive: true });
            const datePrefix = new Date().toISOString().slice(0, 10);
            const fname = `${datePrefix}_${sanitizeForFilename(update.match.name)}.log`;
            matchStreams.set(update.eventId, fs.createWriteStream(path.join(sportDir, fname), { flags: "a" }));
          }
          let context = "";
          if (update.match.serving > 0) {
            const server = update.match.serving === 1 ? update.match.team1 : update.match.team2;
            context = ` (serving: ${server})`;
          }
          const prefix = update.type === "odds" ? "[ODDS]" : "[EVENT]";
          const line = `${new Date().toISOString()} ${prefix}${context}  ${update.changes.join(", ")}\n`;
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
    if (SAVE_RAW_LOGS) {
      const line = `${new Date().toISOString()} SENT ${payload}\n`;
      wsStreams.get(params.requestId)?.write(line);
    }
    console.log("WS sent", payload.slice(0, 120));
  });

  client.on("Network.webSocketClosed", (params: AnyObj, sessionId: string) => {
    if (!trackedIds.has(params.requestId)) return;
    console.log("WS closed", params.requestId);
    if (SAVE_RAW_LOGS) {
      wsStreams.get(params.requestId)?.end();
      wsStreams.delete(params.requestId);
    }
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

  // Periodically log a summary of all live matches
  /*
  setInterval(() => {
    const live = stateManager.getLiveMatches();
    if (live.length === 0) return;
    console.log(`\n── Live Matches (${live.length}) ──`);
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
