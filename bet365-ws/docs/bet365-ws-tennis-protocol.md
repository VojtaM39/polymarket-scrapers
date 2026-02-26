# Bet365 WebSocket Protocol - Tennis Data Format

Reverse-engineered from WebSocket traffic captured at `wss://premws-pt1.us.365lpodds.com/zap/`.

## Protocol Overview

The protocol uses a custom text-based format with pipe-delimited segments. Each WebSocket message contains multiple updates bundled together.

### Delimiter Hierarchy

| Delimiter | Purpose | Example |
|-----------|---------|---------|
| `\|` (pipe) | Separates segments (records) within a message | `OV...U\|fields;\|OV...U\|fields;\|` |
| `;` (semicolon) | Separates key=value fields within a segment | `SS=3-6;XP=40-15;PI=1,0;` |
| `=` (equals) | Separates field name from value | `OD=9/2` |
| `~` (tilde) | Separates sub-values within a field | `FF=1~IA` |
| `,` (comma) | Separates list items (e.g. set scores) | `SS=3-6,1-0` |
| `-` (hyphen) | Separates two sides of a score | `6-3` |

---

## Message Types

### 1. Full-State Dump (suffix `F`)

Sent once after subscription. Contains the entire in-play event tree for all sports.

```
OVInPlay_32_0F|CL;...;NA=Tennis;...|CT;...;NA=ATP Santiago;...|EV;...;NA=Navone v Darderi;...|MA;...;NA=Money Line;...|PA;...;OD=9/2;...|PA;...;OD=1/7;...|...
```

The first segment is the topic ID with `F` suffix. Subsequent segments are records in a hierarchical order:

- **CL** = Category/League (top-level sport: Tennis, Basketball, etc.)
- **CT** = Competition/Tournament (e.g. ATP Santiago, WTA Merida)
- **EV** = Event (a specific match)
- **MA** = Market (a betting market, e.g. Money Line)
- **PA** = Participant/Selection (an outcome with odds)

### 2. Incremental Update (suffix `U`)

Most common. Only changed fields are sent.

```
OV190321250C13A_32_0U|PI=0,1;XP=0-0;SS=3-6,1-0;|OV190340113-701873422_32_0U|OD=4/1;|
```

Format: `<ItemID>U|<changed_fields>;|`

### 3. Deletion (suffix `D`)

```
OV190321250C13A_32_0D||
```

### 4. Heartbeat

```
__time|IN;TI=20260225235708061;UF=10;|
```

- `TI` = timestamp (YYYYMMDDHHmmssSSS)
- `UF` = update frequency

### 5. Subscription (client → server)

```
#P__time,P-ENDP,S_<SESSION_ID>,A_<BASE64_COMPRESSED_DATA>
```

---

## Item ID Structure

Item IDs encode the entity type and relationships:

```
OV<eventId>C<categoryId>A_32_0       → Event record
OV<eventId>C<categoryId>-<marketNum>_32_0  → Market record
OV<fixtureId>-<selectionId>_32_0     → Selection/Participant record
```

**Tennis category = C13** (`CL=13`).

### Example: Mariano Navone v Luciano Darderi

| Entity | Item ID | Meaning |
|--------|---------|---------|
| Event | `OV190321250C13A_32_0` | eventId=190321250, category=13 (Tennis) |
| Market | `OV190321250C13-1763_32_0` | market 1763 (Money Line) on this event |
| Selection 1 | `OV190340113-701873422_32_0` | Navone (OR=0) |
| Selection 2 | `OV190340113-701873420_32_0` | Darderi (OR=1) |

The `OI` field in the EV record links to the fixture ID used in MA/PA records (e.g. `OI=190340113`).

---

## Tennis Event (EV) Fields

Full example:
```
EV;AC=;AD=1;AT=217598;AU=0;BS=0;C1=1;C2=130479967;C3=0;
CB=??ANCUIRKPSYVE;CC=21124106;CE=0;CK=21124106;CL=13;
CP=;CT=ATP Santiago;DC=0;ES=2;ET=0;EX=;FB=0;FF=1~IA;
FS=1;HP=1;HT=201560;ID=190321250C13A_32_0;IH=0;
IT=OV190321250C13A_32_0;K1=;K2=;KC=;KI=;MP=36;
MS=105873342;NA=Mariano Navone v Luciano Darderi;
OF=11111;OI=190340113;OR=0;PE=;PI=1,0;SB=0;SD=0;SE=0;
SS=3-6,0-0;SV=1;T1=5;T2=5;T3=0;T4=;TD=0;TF=1;TM=0;
TS=0;TT=0;TU=;TX=;UC=;VI=1;VS=;XP=40-15;
```

### Key Fields

| Field | Meaning | Example | Notes |
|-------|---------|---------|-------|
| **NA** | Match name | `Mariano Navone v Luciano Darderi` | `P1 v P2` (singles), `P1/P2 v P3/P4` (doubles) |
| **SS** | Set scores | `3-6,0-0` | Comma-separated per set: `P1games-P2games` |
| **XP** | Point score (current game) | `40-15` | Tennis scoring: 0, 15, 30, 40, A |
| **PI** | Point indicator | `1,0` | First digit: 0=P1 serving, 1=P2 serving |
| **FS** | Is active/serving | `1` | 1=in play |
| **CL** | Sport category | `13` | 13 = Tennis |
| **CT** | Tournament name | `ATP Santiago` | |
| **CC** | Competition code | `21124106` | Numeric ID |
| **ES** | Event status | `2` | empty=pre-match, 0=in-play (active), 2=in-play (between games) |
| **ID** | Event identifier | `190321250C13A_32_0` | |
| **OI** | Odds fixture ID | `190340113` | Links to MA/PA records |
| **OF** | Offer flags | `11111` | 5-bit flags for market availability |
| **SM** | Scheduled match time | `1772060400` | Unix timestamp |
| **TU** | Last updated | `20260225235715` | YYYYMMDDHHmmss |
| **OR** | Display order | `0` | |

### Score Encoding

**SS (Set Scores):** `3-6,0-0`
- Comma-separated sets
- Each set: `Player1Games-Player2Games`
- Example: `3-6,1-0` = lost first set 3-6, leading second set 1-0

**XP (Point Score):** `40-15`
- Current game score: `Player1-Player2`
- Values: `0`, `15`, `30`, `40`, `A` (advantage)
- Deuce: `40-40`
- Advantage: `A-40` or `40-A`

**PI (Server Indicator):** `1,0`
- First digit: `0` = Player 1 serving, `1` = Player 2 serving
- Second digit: appears to relate to point/set state

### Score Update Sequence (observed)

```
Initial:    SS=3-6,0-0;  XP=40-15;  PI=1,0;    → Set 2 at 0-0, 40-15, P2 serving
Update 1:   XP=40-30;                            → P2 wins a point
Update 2:   PI=0,1;XP=0-0;SS=3-6,1-0;           → P1 wins game → 1-0 in Set 2
Update 3:   XP=15-0;                             → New game starts
```

When a game is won:
- `SS` updates with new games count
- `XP` resets to `0-0`
- `PI` toggles server (first digit flips)

---

## Market (MA) Fields

```
MA;CN=2;FI=190340113;ID=1763;IT=OV190321250C13-1763_32_0;
MA=1763;NA=Money Line;OR=0;PC=OV_13_32_0;PE=0;SU=0;SY=0;TO=1~GD;
```

| Field | Meaning | Example |
|-------|---------|---------|
| **NA** | Market name | `Money Line` |
| **MA** | Market type ID | `1763` |
| **CN** | Count of selections | `2` |
| **FI** | Fixture ID | `190340113` |
| **SU** | Suspended | `0`=active, `1`=suspended |

### Known Tennis Market IDs

| ID | Name | Description |
|----|------|-------------|
| 1763 | Money Line | Match winner |
| 130020 | Current Set | Current set winner |
| 130468 | Next Game | Next game winner |
| 130078 | Current Game | Current game winner |
| 130170 | Money Line | Alternate money line |
| 130077 | Point Betting | Point-level betting |
| 130476 | Svr Win 0/15/30 | Server win at specific scores |

---

## Selection/Participant (PA) Fields

```
PA;FI=190340113;HA=;HD=;ID=701873422;IT=OV190340113-701873422_32_0;OD=9/2;OR=0;SU=0;
```

| Field | Meaning | Example |
|-------|---------|---------|
| **OD** | Fractional odds | `9/2` (= 5.5 decimal) |
| **OR** | Position | `0`=Player 1, `1`=Player 2 |
| **ID** | Selection ID | `701873422` |
| **FI** | Fixture ID | `190340113` |
| **HA** | Handicap value | empty, or `+4.5` |
| **SU** | Suspended | `0`=active, `1`=suspended |

### Odds Update Examples

```
OV190340113-701873422_32_0U|OD=4/1;|    → Navone odds: 4/1
OV190340113-701873420_32_0U|OD=1/6;|    → Darderi odds: 1/6
```

---

## Category Header (CL) Fields

```
CL;CD=;CL=13;FF=1~IA;HC=10;
HM=1763#Money Line^130170#Money Line^130077#Point Betting;
ID=13;IT=OV_13_32_0;
MR=156#Main##^1763$Money$2$1¬2^130020$Current Set$2$1¬2^130468$Next Game$2$1¬2
  ~157#Game##I7HB^130078$Current$2$1¬2^130468$Next$2$1¬2^130476$Svr Win 0/15/30$2$Yes$No;
NA=Tennis;OF=111;OR=4;
```

| Field | Meaning |
|-------|---------|
| **CL** | Category ID (13=Tennis) |
| **NA** | Sport name |
| **HM** | Header markets (displayed in overview) |
| **MR** | Market registry (defines available market groups) |

---

## Tournament (CT) Fields

```
CT;FF=;ID=13;IP=0;IT=OV21124106-FBKR0C13_32_0;L3=ATP3-R2;NA=ATP Santiago;OF=1;OR=1;
```

| Field | Meaning | Example |
|-------|---------|---------|
| **NA** | Tournament name | `ATP Santiago` |
| **L3** | Level 3 code | `ATP3-R2` (ATP 250, Round 2) |
| **OF** | Has offerings | `1` = yes |

### Tournament Codes Observed

| Tournament | L3 Code | Type |
|-----------|---------|------|
| ATP Acapulco | ATP2-R2 | ATP 500 |
| ATP Santiago | ATP3-R2 | ATP 250 |
| WTA Merida | WTA2-R2 | WTA |
| W35 Arcadia | IWS-R1 | ITF Women $35K |
| W35 Burnie | IWAP-R2 | ITF Women AP |
| UTR Pro Henderson | UTRSM-RR | UTR Pro Men |
| ATP Acapulco MD | ATP2MD-R1 | ATP 500 Doubles |
| ATP Santiago MD | ATP3MD-R2 | ATP 250 Doubles |

---

## Data Hierarchy

```
OVInPlay_32_0 (root subscription)
  └── CL (Sport: CL=13 = Tennis)
       └── CT (Tournament: ATP Santiago)
            └── EV (Match: Navone v Darderi)
                 ├── SS=3-6,0-0 (set scores)
                 ├── XP=40-15 (point score)
                 ├── PI=1,0 (serving indicator)
                 ├── OI=190340113 (odds fixture link)
                 └── MA (Market: Money Line, ID=1763)
                      ├── PA (Navone, OR=0, OD=9/2)
                      └── PA (Darderi, OR=1, OD=1/7)
```

---

## Update Patterns

### Point scored (within a game)
```
OV<eventId>C13A_32_0U|XP=30-40;|
```

### Game won (new game starts)
```
OV<eventId>C13A_32_0U|PI=0,1;XP=0-0;SS=3-6,1-0;|
```

### Odds change
```
OV<fixtureId>-<sel1>_32_0U|OD=4/1;|
OV<fixtureId>-<sel2>_32_0U|OD=1/6;|
```

### Market suspension/unsuspension
```
OV<fixtureId>-<selId>_32_0U|SU=0;|         → suspend
OV<fixtureId>-<selId>_32_0U|SU=1;OD=7/4;|  → unsuspend with new odds
```

### Mixed update (score + odds in one message)
```
OV190340113-701873422_32_0U|OD=4/1;|OV190340113-701873420_32_0U|OD=1/6;|OV190321250C13A_32_0U|PI=0,1;XP=0-0;SS=3-6,1-0;|
```

---

## Sport Category IDs

| CL | Sport |
|----|-------|
| 1 | Soccer/Football |
| 13 | Tennis |
| 16 | Baseball |
| 17 | Ice Hockey |
| 18 | Basketball |
| 151 | (appears paired with other sports - alt view?) |

---

## Notes

- Messages are received every ~200-500ms during active play
- Multiple sport updates are bundled into single WebSocket messages
- Tennis events use `v` as separator in match names (other sports use `@`)
- The `_32_0` suffix appears to be a constant platform/version identifier
- Doubles matches share the same field structure as singles
