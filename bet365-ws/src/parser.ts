/**
 * Bet365 WebSocket Multi-Sport Parser
 *
 * Parses the bet365 custom pipe-delimited protocol and extracts
 * live match state including scores, odds, and match metadata
 * for multiple sports.
 *
 * Protocol delimiters:
 *   | (pipe)     → separates segments within a message
 *   ; (semicol)  → separates key=value fields within a segment
 *   = (equals)   → separates field name from value
 *   , (comma)    → separates list items (e.g. set scores)
 *   - (hyphen)   → separates two sides of a score
 *   ~ (tilde)    → separates sub-values within a field
 */

// ── Sport registry ───────────────────────────────────────────────────────

export interface SportConfig {
  name: string;
  folder: string;
  nameSeparators: string[];
  usesSetScoring: boolean;
  hasServing: boolean;
  hasPointScore: boolean;
}

export const SPORT_REGISTRY: Record<string, SportConfig> = {
  "1":   { name: "Soccer",       folder: "soccer",            nameSeparators: [" v ", " vs "],             usesSetScoring: false, hasServing: false, hasPointScore: false },
  "12":  { name: "Football",     folder: "american-football", nameSeparators: [" @ ", " v "],              usesSetScoring: false, hasServing: false, hasPointScore: false },
  "13":  { name: "Tennis",       folder: "tennis",            nameSeparators: [" v "],                     usesSetScoring: true,  hasServing: true,  hasPointScore: true  },
  "14":  { name: "Snooker",      folder: "snooker",           nameSeparators: [" v "],                     usesSetScoring: true,  hasServing: false, hasPointScore: false },
  "17":  { name: "Hockey",       folder: "hockey",            nameSeparators: [" @ ", " v ", " vs "],      usesSetScoring: false, hasServing: false, hasPointScore: false },
  "18":  { name: "Basketball",   folder: "basketball",        nameSeparators: [" @ ", " vs ", " v "],      usesSetScoring: false, hasServing: false, hasPointScore: false },
  "92":  { name: "Table Tennis", folder: "table-tennis",      nameSeparators: [" v "],                     usesSetScoring: true,  hasServing: true,  hasPointScore: true  },
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface SportMatch {
  eventId: string;
  fixtureId: string;
  itemId: string;
  name: string;
  sportId: string;
  sportName: string;
  team1: string;
  team2: string;
  tournament: string;
  tournamentCode: string;
  status: "pre-match" | "in-play";
  /** Raw SS field value */
  scoreRaw: string;
  /** Per-set scores for set-based sports */
  sets: [number, number][];
  /** Current game/point score for sports that use it */
  currentGame: { p1: string; p2: string };
  /** 0 = N/A, 1 = team1 serving, 2 = team2 serving */
  serving: 0 | 1 | 2;
  markets: Map<string, Market>;
  lastUpdated: string;
  scheduledStart: number;
}

export interface Market {
  id: string;
  name: string;
  suspended: boolean;
  selections: Selection[];
}

export interface Selection {
  id: string;
  odds: string; // fractional e.g. "9/2"
  oddsDecimal: number;
  /** 0 = home/player1, 1 = draw (3-way) or player2 (2-way), 2 = away/player2 */
  position: number;
  suspended: boolean;
}

export type RecordType = "CL" | "CT" | "EV" | "MA" | "PA" | "MG" | "CG" | "unknown";

export interface ParsedSegment {
  /** The raw item ID header (e.g. "OV190321250C13A_32_0U") or record type prefix */
  header: string;
  /** 'F' = full dump, 'U' = update, 'D' = delete, null = part of full dump */
  action: "F" | "U" | "D" | null;
  /** Record type: CL, CT, EV, MA, PA */
  recordType: RecordType;
  /** Parsed key-value fields */
  fields: Record<string, string>;
}

// ── Low-level parsers ──────────────────────────────────────────────────────

/** Parse a semicolon-delimited field string into key-value pairs */
export function parseFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!raw) return fields;
  const parts = raw.split(";");
  for (const part of parts) {
    if (!part) continue;
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) {
      // Record type prefix (e.g. "EV", "MA", "PA")
      fields._type = part;
    } else {
      fields[part.slice(0, eqIdx)] = part.slice(eqIdx + 1);
    }
  }
  return fields;
}

/** Detect the record type from fields */
function detectRecordType(fields: Record<string, string>): RecordType {
  if (fields._type) {
    const t = fields._type as RecordType;
    if (["CL", "CT", "EV", "MA", "PA", "MG", "CG"].includes(t)) return t;
  }
  return "unknown";
}

/** Parse a full OV item ID to extract info */
export function parseItemId(id: string): {
  eventId: string;
  categoryId: string;
  fixtureId: string;
  selectionId: string;
  marketNum: string;
  type: "event" | "market" | "selection" | "unknown";
} {
  const result = {
    eventId: "",
    categoryId: "",
    fixtureId: "",
    selectionId: "",
    marketNum: "",
    type: "unknown" as "event" | "market" | "selection" | "unknown",
  };

  // Strip suffixes: _32_0, _32_0U, _32_0D, _32_0F, _32F, _32U, _32D
  const clean = id.replace(/_(32(_0)?[UDF]?)$/, "");

  // Event: (OV|6V)<eventId>C<catId>A
  const evMatch = clean.match(/^(?:OV|6V)(\d+)C(\d+)A$/);
  if (evMatch) {
    result.type = "event";
    result.eventId = evMatch[1];
    result.categoryId = evMatch[2];
    return result;
  }

  // Market: (OV|6V)<eventId>C<catId>-<marketNum>
  const maMatch = clean.match(/^(?:OV|6V)(\d+)C(\d+)-(\d+)$/);
  if (maMatch) {
    result.type = "market";
    result.eventId = maMatch[1];
    result.categoryId = maMatch[2];
    result.marketNum = maMatch[3];
    return result;
  }

  // Selection: (OV|6V|6VP|OVES)<fixtureId>-<selectionId>
  const paMatch = clean.match(/^(?:OV|6VP?|OVES)(\d+)-0?(\d+)$/);
  if (paMatch) {
    result.type = "selection";
    result.fixtureId = paMatch[1];
    result.selectionId = paMatch[2];
    return result;
  }

  return result;
}

// ── Frame splitting ───────────────────────────────────────────────────────

/**
 * Strip protocol control bytes from raw payload.
 *
 * The bet365 WS protocol embeds:
 *   \x15 (NAK) before each topic header (sub-message start)
 *   \x01 (SOH) before the F/U/D action suffix
 *   \x08 (BS)  between sub-messages (paired with \x15)
 *   \x14 (DC4) occasionally seen as sub-message start
 *
 * We replace \x15 and \x14 with \x1E (record separator) to use as our
 * split delimiter, and strip \x01 and \x08 entirely.
 */
function cleanAndSplit(raw: string): string[] {
  // Replace sub-message delimiters with a known separator
  const normalized = raw.replace(/[\x14\x15]/g, "\x1E").replace(/[\x00\x01\x08]/g, "");
  return normalized.split("\x1E").filter((s) => s.length > 0);
}

/** Detect if a pipe-split segment is a topic header (starts a new sub-message) */
function isTopicHeader(segment: string): boolean {
  if (!segment) return false;
  // Standard: ..._32_0F, ..._32_0U, ..._32_0D
  if (/_32_0[FUD]$/.test(segment)) return true;
  // Alternate subscription: ..._32F, ..._32U, ..._32D
  if (/_32[FUD]$/.test(segment)) return true;
  // EMPTY ack
  if (/^EMPTY[FUD]$/i.test(segment)) return true;
  // Heartbeat
  if (segment === "__time") return true;
  // Subscription (client→server)
  if (segment.startsWith("#")) return true;
  return false;
}

/**
 * Split a raw WS frame into sub-messages.
 *
 * The protocol uses \x15 (NAK) as sub-message boundary and \x01 (SOH)
 * before the F/U/D suffix. After cleaning control bytes, each sub-message
 * is: TOPIC_HEADER|FIELDS;|FIELDS;|...
 *
 * Falls back to pipe-based header detection for clean data (tests).
 */
function splitFrame(raw: string): string[][] {
  // Try control-byte splitting first (real protocol)
  const chunks = cleanAndSplit(raw);

  if (chunks.length > 1) {
    // Each chunk is a complete sub-message
    return chunks.map((chunk) => chunk.split("|"));
  }

  // No control-byte delimiters — fall back to pipe-based header detection
  // (handles clean test data and old-format logs)
  const parts = (chunks[0] || raw).split("|");
  const subMessages: string[][] = [];
  let current: string[] = [];

  for (const part of parts) {
    if (isTopicHeader(part)) {
      if (current.length > 0) {
        subMessages.push(current);
      }
      current = [part];
    } else {
      current.push(part);
    }
  }
  if (current.length > 0) {
    subMessages.push(current);
  }
  return subMessages;
}

/**
 * Parse a raw WebSocket message into segments.
 * Kept for external use / debugging.
 */
export function parseMessage(raw: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  if (!raw) return segments;

  const subMessages = splitFrame(raw);
  for (const parts of subMessages) {
    if (parts.length === 0) continue;
    const header = parts[0];
    if (!header || header === "__time" || header.startsWith("#") || /^EMPTY/i.test(header)) continue;

    if (header.endsWith("F")) {
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i].trim();
        if (!part) continue;
        const fields = parseFields(part);
        segments.push({
          header,
          action: "F",
          recordType: detectRecordType(fields),
          fields,
        });
      }
    } else if (header.endsWith("U") || header.endsWith("D")) {
      const action = header.endsWith("U") ? ("U" as const) : ("D" as const);
      const fields = parseFields(parts[1]?.trim() || "");
      segments.push({
        header,
        action,
        recordType: "unknown",
        fields,
      });
    }
  }

  return segments;
}

// ── Score parsers ──────────────────────────────────────────────────────────

/** Parse set scores string "3-6,1-0" into [[3,6],[1,0]] */
export function parseSetScores(ss: string): [number, number][] {
  if (!ss) return [];
  return ss.split(",").map((set) => {
    const [a, b] = set.split("-");
    return [parseInt(a, 10) || 0, parseInt(b, 10) || 0];
  });
}

/** Parse point score "40-15" into {p1:"40", p2:"15"} */
export function parsePointScore(xp: string): { p1: string; p2: string } {
  if (!xp) return { p1: "0", p2: "0" };
  const [p1, p2] = xp.split("-");
  return { p1: p1 || "0", p2: p2 || "0" };
}

/** Convert fractional odds "9/2" to decimal 5.5 */
export function fractionalToDecimal(odds: string): number {
  if (!odds || !odds.includes("/")) return 0;
  const [num, den] = odds.split("/");
  const n = parseFloat(num);
  const d = parseFloat(den);
  if (!d) return 0;
  return n / d + 1;
}

/** Parse server from PI field: first digit 0=P2 serving, 1=P1 serving */
function parseServing(pi: string): 1 | 2 {
  if (!pi) return 1;
  const first = pi.split(",")[0];
  return first === "1" ? 1 : 2;
}

/** Split team/player names using sport-specific separators */
function parseTeams(name: string, sportId: string): [string, string] {
  const config = SPORT_REGISTRY[sportId];
  if (config) {
    for (const sep of config.nameSeparators) {
      const idx = name.indexOf(sep);
      if (idx !== -1) {
        return [name.slice(0, idx).trim(), name.slice(idx + sep.length).trim()];
      }
    }
  }
  // Fallback: try common separators
  for (const sep of [" v ", " vs ", " @ "]) {
    const idx = name.indexOf(sep);
    if (idx !== -1) {
      return [name.slice(0, idx).trim(), name.slice(idx + sep.length).trim()];
    }
  }
  return [name, ""];
}

// ── State manager ──────────────────────────────────────────────────────────

export class StateManager {
  /** eventId → SportMatch */
  matches = new Map<string, SportMatch>();

  /** fixtureId → eventId (reverse lookup for odds updates) */
  private fixtureToEvent = new Map<string, string>();

  /** selectionId → { fixtureId, position } */
  private selectionInfo = new Map<string, { fixtureId: string; position: number }>();

  /** itemId → eventId (for incremental updates targeting event records) */
  private itemToEvent = new Map<string, string>();

  /** Track current context during full dump parsing */
  private currentTournament = "";
  private currentTournamentCode = "";
  private currentCategory = "";
  private currentSportId = "";
  private inSupportedSport = false;
  private lastEventId = "";

  /**
   * Process a raw WebSocket message payload.
   * Handles frames that contain multiple concatenated sub-messages.
   * Returns list of events that had meaningful changes.
   */
  processMessage(raw: string): MatchUpdate[] {
    const subMessages = splitFrame(raw);
    const updates: MatchUpdate[] = [];

    for (const parts of subMessages) {
      if (parts.length === 0) continue;
      const header = parts[0];

      // Skip non-data messages (heartbeats, subscriptions, empty acks)
      if (!header || header === "__time" || header.startsWith("#") || /^EMPTY/i.test(header)) continue;

      if (header.endsWith("F")) {
        // Full dump sub-message — parse records from remaining parts
        const segments: ParsedSegment[] = [];
        for (let i = 1; i < parts.length; i++) {
          const part = parts[i].trim();
          if (!part) continue;
          const fields = parseFields(part);
          segments.push({
            header,
            action: "F",
            recordType: detectRecordType(fields),
            fields,
          });
        }
        // Only clear state for the global InPlay subscription
        const isGlobalDump = header.includes("InPlay");
        this.processFullDump(segments, isGlobalDump);
      } else if (header.endsWith("U") || header.endsWith("D") || header.endsWith("I")) {
        // Incremental update/delete/insert
        // Headers may contain hierarchical paths (e.g. "parent/child/targetD")
        // Use the last path segment as the actual item ID
        const lastSeg = header.includes("/") ? header.split("/").pop()! : header;
        const suffix = lastSeg.slice(-1);
        const action = suffix === "D" ? ("D" as const) : ("U" as const);
        const fields = parseFields(parts[1]?.trim() || "");
        const seg: ParsedSegment = { header: lastSeg, action, recordType: "unknown", fields };
        const update = this.processUpdate(seg);
        if (update) updates.push(update);
      }
    }

    return updates;
  }

  private processFullDump(segments: ParsedSegment[], isGlobalDump: boolean) {
    this.inSupportedSport = false;
    this.currentSportId = "";
    this.currentTournament = "";
    this.currentTournamentCode = "";
    this.currentCategory = "";
    this.lastEventId = "";

    if (isGlobalDump) {
      this.matches.clear();
      this.fixtureToEvent.clear();
      this.selectionInfo.clear();
      this.itemToEvent.clear();
    }

    for (const seg of segments) {
      const f = seg.fields;
      const rt = seg.recordType;

      if (rt === "CL") {
        this.currentSportId = f.CL || "";
        this.inSupportedSport = !!SPORT_REGISTRY[this.currentSportId];
        continue;
      }

      // For match-detail subscriptions (6V, 151...), EV records carry CL
      // without a preceding CL record
      if (rt === "EV" && f.CL && SPORT_REGISTRY[f.CL]) {
        this.currentSportId = f.CL;
        this.inSupportedSport = true;
      }

      if (!this.inSupportedSport) continue;

      if (rt === "CT") {
        this.currentTournament = f.NA || "";
        this.currentTournamentCode = f.CC || f.ID || "";
        this.currentCategory = f.L3 || "";
        continue;
      }

      if (rt === "EV") {
        const eventId = this.extractEventId(f.ID || "");
        if (!eventId) continue;

        const sportId = f.CL || this.currentSportId;
        const sportConfig = SPORT_REGISTRY[sportId];
        if (!sportConfig) continue;

        const [t1, t2] = parseTeams(f.NA || "", sportId);
        const match: SportMatch = {
          eventId,
          fixtureId: f.OI || "",
          itemId: f.IT || f.ID || "",
          name: f.NA || "",
          sportId,
          sportName: sportConfig.name,
          team1: t1,
          team2: t2,
          tournament: f.CT || this.currentTournament,
          tournamentCode: f.CC || this.currentTournamentCode,
          status: f.ES === "" || f.ES === undefined ? "pre-match" : "in-play",
          scoreRaw: f.SS || "",
          sets: sportConfig.usesSetScoring ? parseSetScores(f.SS) : [],
          currentGame: sportConfig.hasPointScore ? parsePointScore(f.XP) : { p1: "0", p2: "0" },
          serving: sportConfig.hasServing ? parseServing(f.PI) : 0,
          markets: new Map(),
          lastUpdated: f.TU || "",
          scheduledStart: parseInt(f.SM, 10) || 0,
        };

        this.matches.set(eventId, match);
        if (match.fixtureId) {
          this.fixtureToEvent.set(match.fixtureId, eventId);
        }
        this.itemToEvent.set(f.IT || f.ID || "", eventId);
        this.lastEventId = eventId;
        continue;
      }

      if (rt === "MA" && this.lastEventId) {
        const match = this.matches.get(this.lastEventId);
        if (!match) continue;
        const market: Market = {
          id: f.MA || f.ID || "",
          name: f.NA || "",
          suspended: f.SU === "1",
          selections: [],
        };
        match.markets.set(market.id, market);
        continue;
      }

      if (rt === "PA" && this.lastEventId) {
        const match = this.matches.get(this.lastEventId);
        if (!match) continue;

        const sel: Selection = {
          id: f.ID || "",
          odds: f.OD || "",
          oddsDecimal: fractionalToDecimal(f.OD || ""),
          position: parseInt(f.OR, 10) || 0,
          suspended: f.SU === "1",
        };

        // Add to the last market of this match
        let lastMarket: Market | undefined;
        for (const m of match.markets.values()) lastMarket = m;
        if (lastMarket) {
          lastMarket.selections.push(sel);
        }

        // Register for reverse lookup
        if (f.FI) {
          this.selectionInfo.set(f.ID || "", {
            fixtureId: f.FI,
            position: sel.position,
          });
        }
        continue;
      }
    }
  }

  private processUpdate(seg: ParsedSegment): MatchUpdate | null {
    if (!seg.header) return null;

    const itemId = seg.header.replace(/[UD]$/, "");
    const f = seg.fields;

    // 1. Direct event update (OV<eventId>C<catId>A_32_0U)
    const parsedId = parseItemId(itemId);

    if (parsedId.type === "event") {
      const sportConfig = SPORT_REGISTRY[parsedId.categoryId];
      if (!sportConfig) return null;

      const match = this.matches.get(parsedId.eventId);
      if (!match) return null;

      const changes: string[] = [];

      if (f.SS !== undefined) {
        const oldScore = match.scoreRaw;
        match.scoreRaw = f.SS;
        if (sportConfig.usesSetScoring) {
          const oldSets = match.sets.map((s) => s.join("-")).join(",");
          match.sets = parseSetScores(f.SS);
          const newSets = match.sets.map((s) => s.join("-")).join(",");
          if (oldSets !== newSets) changes.push(`sets: ${newSets}`);
        } else if (oldScore !== f.SS) {
          changes.push(`score: ${f.SS}`);
        }
      }
      if (f.XP !== undefined && sportConfig.hasPointScore) {
        const oldGame = `${match.currentGame.p1}-${match.currentGame.p2}`;
        match.currentGame = parsePointScore(f.XP);
        const newGame = `${match.currentGame.p1}-${match.currentGame.p2}`;
        if (oldGame !== newGame) changes.push(`game: ${newGame}`);
      }
      if (f.PI !== undefined && sportConfig.hasServing) {
        const oldServing = match.serving;
        match.serving = parseServing(f.PI);
        if (oldServing !== match.serving) changes.push(`serving: P${match.serving}`);
      }
      if (f.TU) match.lastUpdated = f.TU;
      if (f.ES !== undefined) {
        match.status = f.ES === "" ? "pre-match" : "in-play";
      }

      if (seg.action === "D") {
        this.matches.delete(parsedId.eventId);
        return { type: "delete", eventId: parsedId.eventId, match, changes: ["deleted"] };
      }

      if (changes.length > 0) {
        return { type: "score", eventId: parsedId.eventId, match, changes };
      }
      return null;
    }

    // 2. Selection/odds update (OV<fixtureId>-<selectionId>_32_0U)
    if (parsedId.type === "selection") {
      const eventId = this.fixtureToEvent.get(parsedId.fixtureId);
      if (!eventId) return null;

      const match = this.matches.get(eventId);
      if (!match) return null;

      const changes: string[] = [];

      // Find and update the selection across all markets
      for (const market of match.markets.values()) {
        for (const sel of market.selections) {
          if (sel.id === parsedId.selectionId) {
            if (f.OD !== undefined && f.OD !== sel.odds) {
              const oldOdds = sel.odds;
              sel.odds = f.OD;
              sel.oddsDecimal = fractionalToDecimal(f.OD);
              const isThreeWay = market.selections.length >= 3;
              const teamName = sel.position === 0 ? match.team1 : sel.position === 1 ? (isThreeWay ? "Draw" : match.team2) : match.team2;
              changes.push(`${teamName}: ${oldOdds} → ${f.OD}`);
            }
            if (f.SU !== undefined) {
              sel.suspended = f.SU === "1";
            }
          }
        }
      }

      if (changes.length > 0) {
        return { type: "odds", eventId, match, changes };
      }
      return null;
    }

    return null;
  }

  private extractEventId(id: string): string {
    // From "190321250C13A_32_0" or "6V190284886C13A_32_0" extract eventId
    const m = id.match(/^(?:OV|6V)?(\d+)C/);
    return m ? m[1] : "";
  }

  getAllMatches(): SportMatch[] {
    return Array.from(this.matches.values());
  }

  getLiveMatches(): SportMatch[] {
    return this.getAllMatches().filter((m) => m.status === "in-play");
  }

  getMatchesBySport(sportId: string): SportMatch[] {
    return this.getAllMatches().filter((m) => m.sportId === sportId);
  }
}

export interface MatchUpdate {
  type: "score" | "odds" | "delete";
  eventId: string;
  match: SportMatch;
  changes: string[];
}

// ── Formatting helpers ─────────────────────────────────────────────────────

/** Format a match state as a compact one-line summary */
export function formatMatchSummary(m: SportMatch): string {
  const config = SPORT_REGISTRY[m.sportId];
  let scoreStr = m.scoreRaw;

  if (config?.usesSetScoring && m.sets.length > 0) {
    scoreStr = m.sets.map(([a, b]) => `${a}-${b}`).join(" ");
    if (config.hasPointScore) {
      scoreStr += ` (${m.currentGame.p1}-${m.currentGame.p2})`;
    }
  }

  const servingMark1 = m.serving === 1 ? "*" : "";
  const servingMark2 = m.serving === 2 ? "*" : "";

  let oddsStr = "";
  // Try first market with 2+ selections as money line
  for (const market of m.markets.values()) {
    if (market.selections.length >= 2) {
      const sorted = [...market.selections].sort((a, b) => a.position - b.position);
      if (sorted.length >= 3) {
        // 3-way market (1X2): home / draw / away
        oddsStr = ` | ${sorted[0].odds} / ${sorted[1].odds} / ${sorted[2].odds}`;
      } else {
        oddsStr = ` | ${sorted[0].odds} / ${sorted[1].odds}`;
      }
      break;
    }
  }

  return (
    `[${m.sportName}/${m.tournament}] ${servingMark1}${m.team1} v ${servingMark2}${m.team2}` +
    ` | ${scoreStr}${oddsStr}`
  );
}

/** Format an update for logging */
export function formatUpdate(update: MatchUpdate, nameFilter: string | undefined, passOdds: boolean): string | null {
  if (
    !!nameFilter
    && !update.match.team1.includes(nameFilter)
    && !update.match.team2.includes(nameFilter)
  ) {
    return null;
  }
  if (update.type === "odds" && !passOdds) {
    return null;
  }

  const prefix = update.type === "score" ? "EVENT" : update.type === "odds" ? "ODDS" : "DEL";
  const ts = new Date().toISOString().slice(11, 23);
  return `${ts} [${prefix}] [${update.match.sportName}] ${update.match.name}: ${update.changes.join(", ")}`;
}
