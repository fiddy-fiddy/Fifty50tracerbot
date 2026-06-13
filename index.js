// FiddyBot - Discord bot with Stripe Payment Link + Discord OAuth integration
// Deploy this to Railway. Required env vars:
//   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_ROLE_ID,
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   PUBLIC_URL (e.g. https://fiddybot-production.up.railway.app),
//   DATABASE_URL (Neon Postgres), PORT (Railway sets this)
//   BREVO_API_KEY, FROM_EMAIL (for emailing the connect link after payment)

const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const express = require('express');
const Stripe = require('stripe');
const { Pool } = require('pg');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ====== POSTGRES (Neon) FOR PERSISTENT SUBSCRIBER STORAGE ======
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Neon drops idle connections — don't let that crash the whole bot.
pool.on('error', (err) => console.error('PG pool error (ignored, will reconnect):', err.message));
// Last-resort safety net so one bad request/promise never kills the bot process.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection (ignored):', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception (ignored):', err));

// Run a query, retrying once if the connection was dropped (Neon idle timeout).
async function dbQuery(text, params) {
    try {
        return await pool.query(text, params);
    } catch (err) {
        console.error('DB query failed, retrying once:', err.message);
        return await pool.query(text, params);
    }
}

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bot_subscribers (
            customer_id TEXT PRIMARY KEY,
            discord_id TEXT NOT NULL,
            username TEXT
        );
        CREATE TABLE IF NOT EXISTS bot_pending (
            username_key TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bot_checkout_sessions (
            session_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE bot_checkout_sessions ADD COLUMN IF NOT EXISTS used BOOLEAN DEFAULT FALSE;
    `);
    console.log('Database tables ready.');
}

async function dbSaveCheckoutSession(sessionId, customerId) {
    await dbQuery(
        `INSERT INTO bot_checkout_sessions (session_id, customer_id) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
        [sessionId, customerId]
    );
}
async function dbGetCheckoutSession(sessionId) {
    const r = await dbQuery(`SELECT customer_id, used FROM bot_checkout_sessions WHERE session_id = $1`, [sessionId]);
    if (!r.rows[0]) return null;
    return { customerId: r.rows[0].customer_id, used: r.rows[0].used };
}
// Atomically claim a link so it can only ever be used once. Returns customer_id if
// this caller won the claim, or null if it was already used / doesn't exist.
async function dbClaimCheckoutSession(sessionId) {
    const r = await dbQuery(
        `UPDATE bot_checkout_sessions SET used = TRUE WHERE session_id = $1 AND used = FALSE RETURNING customer_id`,
        [sessionId]
    );
    return r.rows[0]?.customer_id || null;
}

async function dbSaveSubscriber(customerId, discordId, username) {
    await dbQuery(
        `INSERT INTO bot_subscribers (customer_id, discord_id, username) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id) DO UPDATE SET discord_id = EXCLUDED.discord_id, username = EXCLUDED.username`,
        [customerId, discordId, username || null]
    );
}
async function dbGetSubscriber(customerId) {
    const r = await dbQuery(`SELECT discord_id FROM bot_subscribers WHERE customer_id = $1`, [customerId]);
    return r.rows[0]?.discord_id || null;
}
async function dbDeleteSubscriber(customerId) {
    await dbQuery(`DELETE FROM bot_subscribers WHERE customer_id = $1`, [customerId]);
}
async function dbSavePending(usernameKey, customerId) {
    await dbQuery(
        `INSERT INTO bot_pending (username_key, customer_id) VALUES ($1, $2)
         ON CONFLICT (username_key) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
        [usernameKey, customerId]
    );
}
async function dbGetPending(usernameKey) {
    const r = await dbQuery(`SELECT customer_id FROM bot_pending WHERE username_key = $1`, [usernameKey]);
    return r.rows[0]?.customer_id || null;
}
async function dbDeletePending(usernameKey) {
    await dbQuery(`DELETE FROM bot_pending WHERE username_key = $1`, [usernameKey]);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// ====== DATA STORAGE (JSON for bot features, DB for subscribers) ======
let followers = {};
let slips = [];
let leaderboard = {};
let alerts = {};

const FOLLOWERS_FILE = './followers.json';
const SLIPS_FILE = './slips.json';
const LEADERBOARD_FILE = './leaderboard.json';
const ALERTS_FILE = './alerts.json';

if (fs.existsSync(FOLLOWERS_FILE)) followers = JSON.parse(fs.readFileSync(FOLLOWERS_FILE));
if (fs.existsSync(SLIPS_FILE)) slips = JSON.parse(fs.readFileSync(SLIPS_FILE));
if (fs.existsSync(LEADERBOARD_FILE)) leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE));
if (fs.existsSync(ALERTS_FILE)) alerts = JSON.parse(fs.readFileSync(ALERTS_FILE));

function saveFollowers() { fs.writeFileSync(FOLLOWERS_FILE, JSON.stringify(followers, null, 2)); }
function saveSlips() { fs.writeFileSync(SLIPS_FILE, JSON.stringify(slips, null, 2)); }
function saveLeaderboard() { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2)); }
function saveAlerts() { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2)); }

// ====== SWEEP: kick anyone without PAID role or admin perms ======
async function sweepUnpaidMembers() {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const roleId = process.env.DISCORD_ROLE_ID;
        const members = await guild.members.fetch();
        let kicked = 0;
        for (const member of members.values()) {
            if (member.user.bot) continue;
            if (member.id === guild.ownerId) continue;
            if (member.permissions.has(PermissionFlagsBits.Administrator)) continue;
            if (member.permissions.has(PermissionFlagsBits.ManageGuild)) continue;
            if (member.roles.cache.has(roleId)) continue;
            try {
                await member.send(`You were removed from the server because you don't have an active paid subscription. Subscribe again to rejoin.`).catch(() => {});
                await member.kick('No paid role');
                kicked++;
                console.log(`Swept: kicked ${member.user.username}`);
            } catch (e) {
                console.error(`Failed to kick ${member.user.username}:`, e.message);
            }
        }
        console.log(`Sweep complete: kicked ${kicked} unpaid members`);
    } catch (err) {
        console.error('Sweep failed:', err);
    }
}

// ====== LINE HISTORY (Kalshi) — live win-odds movement, pulled on demand ======
// Kalshi lists a market for each game ("will TEAM win?"). The price IS the crowd's
// implied win chance (0.46 = 46%). Reading prices + price history is PUBLIC — no API
// key, no account, no setup. We fetch it live when someone runs /linehistory, so there
// is nothing to poll, store, or pay for.
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Leagues we search, in priority order (we stop at the first confident team match).
// Off-season leagues simply return nothing, so it is safe to keep them all listed.
const KALSHI_LEAGUES = [
    { key: 'mlb',   name: 'MLB',                      series: 'KXMLBGAME' },
    { key: 'nba',   name: 'NBA',                      series: 'KXNBAGAME' },
    { key: 'nhl',   name: 'NHL',                      series: 'KXNHLGAME' },
    { key: 'wnba',  name: 'WNBA',                     series: 'KXWNBAGAME' },
    { key: 'nfl',   name: 'NFL',                      series: 'KXNFLGAME' },
    { key: 'ncaaf', name: 'College Football',         series: 'KXNCAAFGAME' },
    { key: 'ncaab', name: "Men's College Basketball", series: 'KXNCAAMBGAME' },
    { key: 'mls',   name: 'MLS',                      series: 'KXMLSGAME' },
    { key: 'epl',   name: 'Premier League',           series: 'KXEPLGAME' },
    { key: 'ucl',   name: 'Champions League',         series: 'KXUCLGAME' },
    { key: 'wc',    name: 'World Cup',                 series: 'KXWCGAME' },
    { key: 'atp',   name: 'ATP Tennis',               series: 'KXATPGAME' },
    { key: 'wta',   name: 'WTA Tennis',               series: 'KXWTAGAME' }
];

// Turn any text into a simple comparable form: lowercase, letters/numbers/spaces only.
const normTeam = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Common nicknames -> how Kalshi labels that team. Kalshi uses the city, plus a short
// tag when two teams share a city ("Chicago C" = Cubs, "Chicago WS" = White Sox;
// "New York Y" = Yankees, "New York M" = Mets). For some leagues it uses the team
// abbreviation, so a few maps point to that instead. This lets members type "Yankees"
// or "Dodgers". Soccer/tennis/college match fine on city or name, so they need no list.
const KALSHI_ALIASES = {
    mlb: { diamondbacks:'arizona', dbacks:'arizona', braves:'atlanta', orioles:'baltimore', 'red sox':'boston', redsox:'boston', cubs:'chicago c', 'white sox':'chicago ws', whitesox:'chicago ws', reds:'cincinnati', guardians:'cleveland', indians:'cleveland', rockies:'colorado', tigers:'detroit', astros:'houston', royals:'kansas city', angels:'los angeles a', dodgers:'los angeles d', marlins:'miami', brewers:'milwaukee', twins:'minnesota', mets:'new york m', yankees:'new york y', phillies:'philadelphia', pirates:'pittsburgh', padres:'san diego', giants:'san francisco', mariners:'seattle', cardinals:'st louis', cards:'st louis', rays:'tampa bay', rangers:'texas', 'blue jays':'toronto', bluejays:'toronto', jays:'toronto', nationals:'washington', nats:'washington', athletics:'a s', as:'a s', oakland:'a s', sacramento:'a s' },
    nba: { hawks:'atlanta', celtics:'boston', nets:'brooklyn', hornets:'charlotte', bulls:'chicago', cavaliers:'cleveland', cavs:'cleveland', mavericks:'dallas', mavs:'dallas', nuggets:'denver', pistons:'detroit', warriors:'golden state', rockets:'houston', pacers:'indiana', clippers:'los angeles c', lakers:'los angeles l', grizzlies:'memphis', heat:'miami', bucks:'milwaukee', timberwolves:'minnesota', wolves:'minnesota', pelicans:'new orleans', knicks:'new york', thunder:'oklahoma city', magic:'orlando', sixers:'philadelphia', '76ers':'philadelphia', suns:'phoenix', 'trail blazers':'portland', blazers:'portland', kings:'sacramento', spurs:'san antonio', raptors:'toronto', jazz:'utah', wizards:'washington' },
    nhl: { ducks:'ana', bruins:'bos', sabres:'buf', flames:'cgy', hurricanes:'car', canes:'car', blackhawks:'chi', avalanche:'col', avs:'col', 'blue jackets':'cbj', stars:'dal', 'red wings':'det', oilers:'edm', panthers:'fla', kings:'lak', wild:'min', canadiens:'mtl', habs:'mtl', predators:'nsh', preds:'nsh', devils:'njd', islanders:'nyi', rangers:'nyr', senators:'ott', sens:'ott', flyers:'phi', penguins:'pit', pens:'pit', sharks:'sjs', kraken:'sea', blues:'stl', lightning:'tbl', bolts:'tbl', 'maple leafs':'tor', leafs:'tor', canucks:'van', 'golden knights':'vgk', knights:'vgk', capitals:'wsh', caps:'wsh', jets:'wpg', utah:'uta' },
    wnba: { dream:'atlanta', sky:'chicago', sun:'connecticut', wings:'dallas', fever:'indiana', aces:'las vegas', sparks:'los angeles', lynx:'minnesota', liberty:'new york', mercury:'phoenix', fire:'portland', tempo:'toronto', mystics:'washington', valkyries:'golden state' },
    nfl: { cardinals:'arizona', falcons:'atlanta', ravens:'baltimore', bills:'buffalo', panthers:'carolina', bears:'chicago', bengals:'cincinnati', browns:'cleveland', cowboys:'dallas', broncos:'denver', lions:'detroit', packers:'green bay', texans:'houston', colts:'indianapolis', jaguars:'jacksonville', jags:'jacksonville', chiefs:'kansas city', raiders:'las vegas', chargers:'los angeles c', rams:'los angeles r', dolphins:'miami', vikings:'minnesota', vikes:'minnesota', patriots:'new england', pats:'new england', saints:'new orleans', giants:'new york g', jets:'new york j', eagles:'philadelphia', steelers:'pittsburgh', niners:'san francisco', '49ers':'san francisco', seahawks:'seattle', buccaneers:'tampa bay', bucs:'tampa bay', titans:'tennessee', commanders:'washington' }
};

// Player props on Kalshi, grouped by league. Each entry is one stat type:
//  • type 'threshold' = many markets per player (e.g. "25+ / 30+ points"); we chart the
//    line closest to a coin-flip (the "main line", like a sportsbook's over/under number).
//  • type 'binary'    = one yes/no market per player (e.g. "to score or assist").
// The FIRST stat listed for a league is the default when a member types only a name.
// `stat` values must match the /linehistory "stat" menu choices below.
const PLAYER_PROPS = {
    nba: [
        { stat: 'points',   series: 'KXNBAPTS', type: 'threshold', word: 'points' },
        { stat: 'rebounds', series: 'KXNBAREB', type: 'threshold', word: 'rebounds' },
        { stat: 'assists',  series: 'KXNBAAST', type: 'threshold', word: 'assists' },
        { stat: 'threes',   series: 'KXNBA3PT', type: 'threshold', word: 'threes' },
        { stat: 'steals',   series: 'KXNBASTL', type: 'threshold', word: 'steals' },
        { stat: 'blocks',   series: 'KXNBABLK', type: 'threshold', word: 'blocks' }
    ],
    wnba: [
        { stat: 'points',   series: 'KXWNBAPTS', type: 'threshold', word: 'points' },
        { stat: 'rebounds', series: 'KXWNBAREB', type: 'threshold', word: 'rebounds' },
        { stat: 'assists',  series: 'KXWNBAAST', type: 'threshold', word: 'assists' },
        { stat: 'threes',   series: 'KXWNBA3PT', type: 'threshold', word: 'threes' }
    ],
    wc: [
        { stat: 'soa',   series: 'KXWCSOA',         type: 'binary',    word: 'to score or assist' },
        { stat: 'goal',  series: 'KXWCPLAYERGOALS', type: 'binary',    word: 'to score' },
        { stat: 'shots', series: 'KXWCSHOT',        type: 'threshold', word: 'shots' }
    ],
    ucl: [
        { stat: 'soa',   series: 'KXUCLSOA',  type: 'binary',    word: 'to score or assist' },
        { stat: 'goal',  series: 'KXUCLGOAL', type: 'binary',    word: 'to score' },
        { stat: 'shots', series: 'KXUCLSHOT', type: 'threshold', word: 'shots' }
    ],
    epl: [
        { stat: 'soa',  series: 'KXEPLSOA',     type: 'binary', word: 'to score or assist' },
        { stat: 'goal', series: 'KXEPLANYGOAL', type: 'binary', word: 'to score' }
    ],
    nhl: [
        { stat: 'goal', series: 'KXNHLANYGOAL', type: 'binary', word: 'to score' }
    ]
};

// Convert an implied win probability (0..1) to an American moneyline string (e.g. -150, +130).
function probToMoneyline(p) {
    if (!(p > 0 && p < 1)) return '—';
    const ml = p >= 0.5 ? -(p / (1 - p)) * 100 : ((1 - p) / p) * 100;
    const r = Math.round(ml);
    return (r > 0 ? '+' : '') + r;
}

// Pull a usable price (0..1) out of one candlestick: prefer the traded close, otherwise
// the midpoint of the best bid/ask. Returns null if that hour had nothing to show.
function candlePrice(c) {
    const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const close = c && c.price ? num(c.price.close_dollars) : null;
    if (close != null && close > 0 && close < 1) return close;
    const bid = c && c.yes_bid ? num(c.yes_bid.close_dollars) : null;
    const ask = c && c.yes_ask ? num(c.yes_ask.close_dollars) : null;
    if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
    if (ask != null && ask > 0 && ask < 1) return ask;
    if (bid != null && bid > 0 && bid < 1) return bid;
    return null;
}

// fetch() that won't hang forever — aborts after `ms` so a stuck request can't wedge a poll or a command.
async function fetchWithTimeout(url, options = {}, ms = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Tiny in-memory cache so lookups close together don't hammer Kalshi (it rate-limits).
const kalshiCache = new Map(); // path -> { at, data }
function kalshiCacheGet(key, ttlMs) { const e = kalshiCache.get(key); return (e && Date.now() - e.at < ttlMs) ? e.data : null; }

// GET a Kalshi endpoint as JSON: short cache, hard timeout, one retry if rate-limited.
async function kalshiGet(path, ttlMs = 120000) {
    const cached = kalshiCacheGet(path, ttlMs);
    if (cached) return cached;
    for (let attempt = 0; attempt < 2; attempt++) {
        const resp = await fetchWithTimeout(KALSHI_BASE + path, { headers: { Accept: 'application/json' } }, 12000);
        if (resp.status === 429) { await new Promise(r => setTimeout(r, 1500)); continue; }
        if (!resp.ok) throw new Error(`Kalshi HTTP ${resp.status}`);
        const data = await resp.json();
        kalshiCache.set(path, { at: Date.now(), data });
        return data;
    }
    throw new Error('Kalshi rate-limited');
}

// Score how well a user's query matches one market's team (0 = none, ~100 = exact).
function teamMatchScore(query, leagueKey, market) {
    const q = normTeam(query);
    if (!q) return 0;
    const team = normTeam(market.yes_sub_title);
    const abbr = normTeam((market.ticker || '').split('-').pop());
    const target = (KALSHI_ALIASES[leagueKey] || {})[q] || null;
    const candidates = target ? [q, target] : [q];
    let best = 0;
    for (const c of candidates) {
        if (!c) continue;
        if (team === c || abbr === c) best = Math.max(best, c === q ? 100 : 99);
        else if (team.includes(c) || c.includes(team)) best = Math.max(best, team.split(' ').length >= 2 ? 60 : 50);
    }
    if (abbr && abbr === q) best = Math.max(best, 95);
    return best;
}

// Find the best current game market for a team. Searches one league (if given) or the
// whole priority list, stopping early on a confident match. Returns { league, event,
// market, score } or null.
async function findKalshiMarket(query, leagueKey) {
    const leagues = leagueKey ? KALSHI_LEAGUES.filter(l => l.key === leagueKey) : KALSHI_LEAGUES;
    let overallBest = null;
    for (const lg of leagues) {
        let data;
        try { data = await kalshiGet(`/events?series_ticker=${lg.series}&status=open&with_nested_markets=true&limit=80`); }
        catch (e) { if (String(e.message).includes('rate')) throw e; continue; }
        const events = (data && data.events) || [];
        let leagueBest = null;
        for (const ev of events) {
            for (const m of (ev.markets || [])) {
                const s = teamMatchScore(query, lg.key, m);
                if (s <= 0) continue;
                const better = !leagueBest || s > leagueBest.score ||
                    (s === leagueBest.score && new Date(m.close_time) < new Date(leagueBest.market.close_time));
                if (better) leagueBest = { league: lg, event: ev, market: m, score: s };
            }
        }
        if (leagueBest) {
            if (!overallBest || leagueBest.score > overallBest.score) overallBest = leagueBest;
            if (leagueBest.score >= 90) break; // confident match — no need to search other leagues
        }
    }
    return overallBest;
}

// ----- PLAYER PROPS -----
// Player markets put the person's name in yes_sub_title, e.g. "Victor Wembanyama: 30+"
// (threshold props) or just "Lamine Yamal" (yes/no props). Pull the name part out.
function extractPlayerName(yesSub) {
    const s = (yesSub || '').trim();
    const i = s.indexOf(':');
    return (i >= 0 ? s.slice(0, i) : s).trim();
}

// Score how well a typed name matches a player (0 = none, ~100 = exact). Members usually
// type a last name ("salah", "wembanyama") but full names work too.
function playerMatchScore(query, name) {
    const q = normTeam(query);
    const n = normTeam(name);
    if (!q || !n) return 0;
    if (n === q) return 100;
    const qt = q.split(' ').filter(Boolean);
    const nt = n.split(' ').filter(Boolean);
    const last = nt[nt.length - 1];
    if (qt.length >= 2 && qt.every(t => nt.includes(t))) return 92; // all typed words present
    if (n.includes(q)) return qt.length >= 2 ? 90 : 78;             // typed text sits inside the name
    if (qt.length === 1) {
        if (last === q) return 85;                                  // last-name match
        if (nt.includes(q)) return 70;                             // first/middle name match
        if (q.length >= 4 && last.startsWith(q)) return 60;        // partial last name
    }
    return 0;
}

// Best current price (0..1) for a market, from its live quote (traded last, else bid/ask mid).
function currentMarketProb(m) {
    return candlePrice({
        price: { close_dollars: m.last_price_dollars },
        yes_ask: { close_dollars: m.yes_ask_dollars },
        yes_bid: { close_dollars: m.yes_bid_dollars }
    });
}

// Human label for the line we're charting, e.g. "30+ points" or "to score or assist".
function buildLineLabel(market, prop) {
    const sub = market.yes_sub_title || '';
    const i = sub.indexOf(':');
    if (i >= 0) {
        const thr = sub.slice(i + 1).trim(); // "30+"
        return prop.word ? `${thr} ${prop.word}` : thr;
    }
    return prop.word || 'prop';
}

// Find a player's prop market. Searches the chosen stat (or each league's default stat),
// matches the player by name, and for threshold props picks the line closest to 50/50
// (the main line). Bounded: one request per stat series, stops at the first match.
// Returns { leagueName, seriesTicker, event, market, player, prop } or { ambiguous, names } or null.
async function findKalshiPlayer(query, leagueKey, statKey) {
    const leagueKeys = leagueKey
        ? (PLAYER_PROPS[leagueKey] ? [leagueKey] : [])
        : Object.keys(PLAYER_PROPS);
    const searches = [];
    for (const lk of leagueKeys) {
        const props = PLAYER_PROPS[lk] || [];
        const chosen = statKey ? props.filter(p => p.stat === statKey) : (props[0] ? [props[0]] : []);
        if (chosen.length === 0) continue;
        const lgName = (KALSHI_LEAGUES.find(l => l.key === lk) || {}).name || lk.toUpperCase();
        for (const prop of chosen) searches.push({ leagueName: lgName, prop });
    }

    let ambiguousNames = null;
    for (const s of searches) {
        let data;
        try { data = await kalshiGet(`/events?series_ticker=${s.prop.series}&status=open&with_nested_markets=true&limit=80`); }
        catch (e) { if (String(e.message).includes('rate')) throw e; continue; }
        const events = (data && data.events) || [];

        // Group matching markets by player (within an event), keeping their best score.
        const byPlayer = new Map();
        for (const ev of events) {
            for (const m of (ev.markets || [])) {
                if (m.status && m.status !== 'active') continue;
                const name = extractPlayerName(m.yes_sub_title);
                const score = playerMatchScore(query, name);
                if (score <= 0) continue;
                const key = ev.event_ticker + '|' + normTeam(name);
                const cur = byPlayer.get(key) || { name, score: 0, event: ev, markets: [] };
                cur.score = Math.max(cur.score, score);
                cur.markets.push(m);
                byPlayer.set(key, cur);
            }
        }
        if (byPlayer.size === 0) continue;

        const arr = [...byPlayer.values()].sort((a, b) => b.score - a.score);
        const top = arr[0];
        const tiedNames = [...new Set(arr.filter(x => x.score === top.score).map(x => x.name))];
        if (tiedNames.length > 1 && top.score < 95) {
            if (!ambiguousNames) ambiguousNames = tiedNames.slice(0, 5);
            continue; // keep looking in case another stat series has a clean match
        }

        // Pick the main line: the player's market whose live price is closest to 50/50.
        const priced = top.markets.map(m => ({ m, p: currentMarketProb(m) })).filter(x => x.p != null);
        let mainMarket;
        if (priced.length) {
            priced.sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5));
            mainMarket = priced[0].m;
        } else {
            mainMarket = top.markets[0]; // unpriced — still return so we can show "no line yet"
        }
        return {
            leagueName: s.leagueName,
            seriesTicker: s.prop.series,
            event: top.event,
            market: mainMarket,
            player: top.name,
            prop: { ...s.prop, lineLabel: buildLineLabel(mainMarket, s.prop) }
        };
    }
    if (ambiguousNames) return { ambiguous: true, names: ambiguousNames };
    return null;
}

// Shape a team match into the common "view" the chart/embed code below reads.
function teamView(match) {
    const subject = match.market.yes_sub_title || 'This team';
    return {
        seriesTicker: match.league.series,
        leagueName: match.league.name,
        event: match.event,
        market: match.market,
        nowLabel: subject,
        lineNote: 'to win',
        chartLabel: `${subject} win chance (%)`,
        chartTitle: `${match.event.title} — ${subject} win odds`,
        embedTitle: `📈 Line Movement — ${match.event.title}`,
        line1: `**${subject}** to win · ${match.league.name}`,
        axis: 'Win chance (%)'
    };
}

// Shape a player match into the common "view".
function playerView(pm) {
    const line = pm.prop.lineLabel;
    return {
        seriesTicker: pm.seriesTicker,
        leagueName: pm.leagueName,
        event: pm.event,
        market: pm.market,
        nowLabel: pm.player,
        lineNote: line,
        chartLabel: `${pm.player} ${line} (%)`,
        chartTitle: `${pm.event.title} — ${pm.player}: ${line}`,
        embedTitle: `📈 Line Movement — ${pm.player}`,
        line1: `**${pm.player}** — ${line} · ${pm.leagueName} · ${pm.event.title}`,
        axis: 'Chance (%)'
    };
}

// Pull ~7 days of hourly price history for one market and return chart-ready points.
async function fetchKalshiHistory(seriesTicker, marketTicker) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 7 * 24 * 3600;
    const data = await kalshiGet(`/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${start}&end_ts=${now}&period_interval=60`, 300000);
    const candles = (data && data.candlesticks) || [];
    const points = [];
    for (const c of candles) {
        const p = candlePrice(c);
        if (p == null) continue;
        points.push({ ts: (c.end_period_ts || 0) * 1000, prob: p });
    }
    points.sort((a, b) => a.ts - b.ts); // chart oldest -> newest, even if upstream order changes
    return points;
}

// Build a hosted line-chart image (via QuickChart) and return its URL.
async function makeChartUrl(config) {
    const resp = await fetchWithTimeout('https://quickchart.io/chart/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart: config, width: 700, height: 360, backgroundColor: 'white' })
    });
    const data = await resp.json();
    if (data && data.success && data.url) return data.url;
    throw new Error('chart create failed');
}

// Format a timestamp like "6/13 2 PM" in US Eastern time
function shortTime(d) {
    try {
        return new Date(d).toLocaleString('en-US', {
            timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric'
        }).replace(',', '');
    } catch (e) {
        return new Date(d).toISOString().slice(5, 16);
    }
}

// ====== BOT READY & COMMAND REGISTRATION ======
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);
    try { await initDb(); } catch (e) { console.error('DB init failed:', e); }

    // Auto-sweep DISABLED on purpose. It kicked EVERY member without the PAID role,
    // including the owner's friends/staff and customers who had paid but not yet
    // clicked their Discord connect link. Removal now happens only via Stripe
    // webhooks (cancel / refund / dispute), which is precise and safe.
    // sweepUnpaidMembers();
    // setInterval(sweepUnpaidMembers, 6 * 60 * 60 * 1000);

    // Admin-only commands are hidden from regular members via defaultMemberPermissions.
    // Only /stats is visible to everyone.
    const ADMIN_ONLY = PermissionFlagsBits.ManageGuild;
    const data = [
        { name: 'follow', description: 'Follow a bettor', options: [{ name: 'target', type: 6, description: 'User to follow', required: true }], defaultMemberPermissions: ADMIN_ONLY },
        { name: 'unfollow', description: 'Stop following a bettor', options: [{ name: 'target', type: 6, description: 'User to unfollow', required: true }], defaultMemberPermissions: ADMIN_ONLY },
        { name: 'following', description: 'See who you are following', defaultMemberPermissions: ADMIN_ONLY },
        { name: 'feed', description: 'See recent slips from users you follow', defaultMemberPermissions: ADMIN_ONLY },
        { name: 'alerts', description: 'Turn DM alerts on or off', options: [{ name: 'state', type: 3, description: 'on or off', required: true }], defaultMemberPermissions: ADMIN_ONLY },
        { name: 'addwin', description: 'Add a win to the leaderboard', options: [{ name: 'name', type: 3, description: 'Bettor name', required: true }, { name: 'odds', type: 4, description: 'Win amount (+/- value)', required: true }], defaultMemberPermissions: ADMIN_ONLY },
        { name: 'resetleaderboard', description: 'Admin: reset the entire leaderboard', defaultMemberPermissions: ADMIN_ONLY },
        { name: 'verifywin', description: 'Admin: log a win for a user', options: [{ name: 'target', type: 6, description: 'User to verify', required: true }], defaultMemberPermissions: ADMIN_ONLY },
        { name: 'stats', description: 'Look up sports stats (members chat only)', options: [{ name: 'question', type: 3, description: 'e.g. LeBron James points this season', required: true }] },
        { name: 'linehistory', description: 'Show how a team or player\'s odds have moved (members chat only)', options: [
            { name: 'team', type: 3, description: 'Team OR player name — e.g. Lakers, Wembanyama, Salah', required: true },
            { name: 'league', type: 3, description: 'Optional: narrow the search to one league', required: false, choices: [
                { name: 'MLB', value: 'mlb' },
                { name: 'NBA', value: 'nba' },
                { name: 'NHL', value: 'nhl' },
                { name: 'WNBA', value: 'wnba' },
                { name: 'NFL', value: 'nfl' },
                { name: 'College Football', value: 'ncaaf' },
                { name: 'College Basketball', value: 'ncaab' },
                { name: 'MLS', value: 'mls' },
                { name: 'Premier League', value: 'epl' },
                { name: 'Champions League', value: 'ucl' },
                { name: 'World Cup', value: 'wc' },
                { name: 'ATP Tennis', value: 'atp' },
                { name: 'WTA Tennis', value: 'wta' }
            ] },
            { name: 'stat', type: 3, description: 'For players: which line to chart (default: points / score-or-assist)', required: false, choices: [
                { name: 'Points', value: 'points' },
                { name: 'Rebounds', value: 'rebounds' },
                { name: 'Assists', value: 'assists' },
                { name: '3-Pointers', value: 'threes' },
                { name: 'Steals', value: 'steals' },
                { name: 'Blocks', value: 'blocks' },
                { name: 'Score or Assist (soccer)', value: 'soa' },
                { name: 'Goal (soccer/hockey)', value: 'goal' },
                { name: 'Shots (soccer)', value: 'shots' }
            ] }
        ] },
        { name: 'parlay', description: 'Calculate parlay odds & payout (wins channel only)', options: [{ name: 'odds', type: 3, description: 'Odds per leg, e.g. +150 -110 +200', required: true }, { name: 'stake', type: 10, description: 'Amount you are betting (optional)', required: false }], defaultMemberPermissions: ADMIN_ONLY }
    ];

    try {
        console.log('Registering commands...');
        await client.application.commands.set(data);
        client.guilds.cache.forEach(async (guild) => {
            await guild.commands.set(data);
        });
        console.log('Slash commands registered!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }

    // /linehistory pulls win-odds from Kalshi live, on demand — nothing to schedule here.
});

// ====== #bet-slips: IMAGES/SCREENSHOTS/FILES ONLY + LOG SLIPS ======
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    // Match the bet-slips channel even if it has an emoji/separator in the name
    const cname = (message.channel.name || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!cname.includes('betslips')) return;

    const hasAttachment = message.attachments.size > 0;

    // Staff (owner/mods) can post text freely — e.g. to rank or comment on slips
    const isStaff = message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
        || message.member?.permissions?.has(PermissionFlagsBits.Administrator);

    // Regular members must post an image/screenshot/file — delete text-only posts
    if (!hasAttachment && !isStaff) {
        try {
            await message.delete();
            const warn = await message.channel.send(`<@${message.author.id}> this channel is for **images / screenshots / files only** — please post your bet slip as an image. 🧾`);
            setTimeout(() => warn.delete().catch(() => {}), 7000);
        } catch (e) {
            console.error('bet-slips delete failed (needs Manage Messages permission?):', e.message);
        }
        return;
    }

    // Only log actual slips (messages that include an attachment); skip staff text notes
    if (!hasAttachment) return;

    let attachmentUrl = message.attachments.first() ? message.attachments.first().url : null;
    let slip = {
        userId: message.author.id,
        username: message.author.username,
        content: message.content,
        timestamp: message.createdTimestamp,
        attachmentUrl
    };
    slips.push(slip);
    saveSlips();

    for (const [followerId, targets] of Object.entries(followers)) {
        if (targets.includes(message.author.id) && alerts[followerId]) {
            try {
                const user = await client.users.fetch(followerId);
                await user.send(`New slip from ${message.author.username}:\n${message.content}\n${attachmentUrl || ''}`);
            } catch (err) {
                console.log(`Failed to DM ${followerId}: ${err}`);
            }
        }
    }
});

// ====== AUTO LEADERBOARD TRACKING ======
const WINS_CHANNEL = 'wins';

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (message.channel.name !== WINS_CHANNEL) return;

    const lines = message.content.split('\n');
    for (const line of lines) {
        const match = line.trim().match(/^(.+?)\s([+-]\d+)$/);
        if (!match) continue;

        const name = match[1];
        const odds = parseInt(match[2]);
        if (!leaderboard[name]) leaderboard[name] = 0;
        leaderboard[name] += odds;
    }

    saveLeaderboard();
    updateLeaderboardEmbed(message.guild);
});

async function updateLeaderboardEmbed(guild) {
    const lbChannel = guild.channels.cache.find(c => c.name.toLowerCase().includes('leaderboard'));
    if (!lbChannel) return;

    const sorted = Object.entries(leaderboard).sort((a, b) => b[1] - a[1]).slice(0, 10);
    let output = '';
    let rank = 1;

    for (let i = 0; i < sorted.length; i++) {
        const [name, value] = sorted[i];
        if (i > 0 && value !== sorted[i - 1][1]) rank = i + 1;
        const sign = value >= 0 ? '+' : '';
        const medal = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : '🔹 ';
        output += `${medal}**#${rank}** ${name} • \`${sign}${value}\`\n`;
    }

    const embed = new EmbedBuilder()
        .setTitle('🏆 Fifty50 Leaderboard 🏆')
        .setDescription(output || 'No records yet!')
        .setColor(0x00AE86)
        .setTimestamp()
        .setFooter({ text: 'Fifty50 Betting Community' });

    const messages = await lbChannel.messages.fetch({ limit: 5 });
    await lbChannel.bulkDelete(messages);
    lbChannel.send({ embeds: [embed] });
}

// Decode common HTML entities found in StatMuse meta tags
function decodeEntities(str) {
    return String(str)
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ====== INTERACTION HANDLER ======
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, user } = interaction;

    if (commandName === 'follow') {
        const target = options.getUser('target');
        if (!followers[user.id]) followers[user.id] = [];
        if (!followers[user.id].includes(target.id)) {
            followers[user.id].push(target.id);
            saveFollowers();
            await interaction.reply(`You are now following **${target.username}**`);
        } else {
            await interaction.reply(`You are already following **${target.username}**`);
        }
    }

    if (commandName === 'unfollow') {
        const target = options.getUser('target');
        if (followers[user.id]) {
            followers[user.id] = followers[user.id].filter(id => id !== target.id);
            saveFollowers();
        }
        await interaction.reply(`You unfollowed **${target.username}**`);
    }

    if (commandName === 'following') {
        const followed = followers[user.id] || [];
        if (followed.length === 0) return interaction.reply('You are not following anyone.');
        let names = followed.map(id => client.users.cache.get(id)?.username || 'Unknown').join('\n- ');
        await interaction.reply(`You are following:\n- ${names}`);
    }

    if (commandName === 'feed') {
        const followed = followers[user.id] || [];
        if (followed.length === 0) return interaction.reply('You are not following anyone.');
        let recentSlips = slips
            .filter(slip => followed.includes(slip.userId))
            .slice(-5)
            .map(slip => `${slip.username}: ${slip.content} ${slip.attachmentUrl || ''}`)
            .join('\n\n');
        await interaction.reply(recentSlips || 'No recent slips from followed users.');
    }

    if (commandName === 'alerts') {
        const toggle = options.getString('state');
        alerts[user.id] = toggle.toLowerCase() === 'on';
        saveAlerts();
        await interaction.reply(`DM alerts turned **${toggle.toUpperCase()}**`);
    }

    if (commandName === 'addwin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }
        const name = options.getString('name');
        const odds = options.getInteger('odds');
        if (!leaderboard[name]) leaderboard[name] = 0;
        leaderboard[name] += odds;
        saveLeaderboard();
        updateLeaderboardEmbed(interaction.guild);
        await interaction.reply(`Added win for ${name}`);
    }

    if (commandName === 'resetleaderboard') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }
        leaderboard = {};
        saveLeaderboard();
        updateLeaderboardEmbed(interaction.guild);
        await interaction.reply('Leaderboard reset.');
    }

    // ===== /stats — StatMuse lookup, MEMBERS CHAT ONLY, public =====
    if (commandName === 'stats') {
        const norm = (interaction.channel?.name || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!norm.includes('memberschat')) {
            return interaction.reply({ content: '📊 The `/stats` command can only be used in the members chat.', ephemeral: true });
        }
        const question = options.getString('question');
        await interaction.deferReply();
        try {
            const url = `https://www.statmuse.com/ask?q=${encodeURIComponent(question)}`;
            const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' } });
            const html = await resp.text();
            const dm = html.match(/<meta property="og:description" content="([^"]*)"/i);
            const im = html.match(/<meta property="og:image" content="([^"]*)"/i);
            const answer = dm ? decodeEntities(dm[1]) : null;
            const image = im ? decodeEntities(im[1]) : null;
            // StatMuse returns a generic marketing blurb + banner when it has no real answer
            const noResult = !answer || /instant answers to your/i.test(answer) || (image && image.includes('sm-meta-banner'));
            if (noResult) {
                return interaction.editReply(`Couldn't find stats for **${question}** — try rephrasing, e.g. \`/stats LeBron James points this season\`.`);
            }
            const embed = new EmbedBuilder()
                .setColor(0x00AE86)
                .setTitle(`📊 ${answer}`.slice(0, 256))
                .setURL(url)
                .setFooter({ text: 'Stats via StatMuse — tap the title for the full breakdown' });
            if (image) embed.setImage(image);
            await interaction.editReply({ content: `**${question}**`, embeds: [embed] });
        } catch (e) {
            console.error('stats command error:', e);
            await interaction.editReply('Something went wrong fetching stats. Please try again in a moment.');
        }
    }

    // ===== /parlay — odds & payout calculator, WINS CHANNEL ONLY =====
    if (commandName === 'parlay') {
        const norm = (interaction.channel?.name || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!norm.includes('wins')) {
            return interaction.reply({ content: '🧮 The `/parlay` command can only be used in the wins channel.', ephemeral: true });
        }
        const oddsStr = options.getString('odds');
        const stake = options.getNumber('stake');
        const tokens = oddsStr.split(/[\s,]+/).filter(Boolean);
        const legs = [];
        for (const t of tokens) {
            if (!/^[+-]?\d+$/.test(t) || parseInt(t, 10) === 0) {
                return interaction.reply({ content: `⚠️ "${t}" isn't valid odds. Use American odds like \`+150 -110 +200\`.`, ephemeral: true });
            }
            legs.push(parseInt(t, 10));
        }
        if (legs.length < 2) {
            return interaction.reply({ content: '🧮 A parlay needs at least 2 legs. Example: `/parlay odds: +150 -110 +200`.', ephemeral: true });
        }
        const toDecimal = (a) => a > 0 ? (a / 100) + 1 : (100 / Math.abs(a)) + 1;
        let combinedDec = 1;
        for (const a of legs) combinedDec *= toDecimal(a);
        const americanNum = combinedDec >= 2 ? (combinedDec - 1) * 100 : -100 / (combinedDec - 1);
        const americanStr = (americanNum > 0 ? '+' : '') + Math.round(americanNum);
        const legsStr = legs.map(a => (a > 0 ? '+' : '') + a).join('  ');

        const embed = new EmbedBuilder()
            .setColor(0xF5A623)
            .setTitle('🧮 Parlay Calculator')
            .addFields(
                { name: 'Legs', value: '`' + legsStr + '`' },
                { name: 'Combined Odds', value: `**${americanStr}**  _(×${combinedDec.toFixed(2)})_` }
            );
        if (stake != null && !isNaN(stake) && stake > 0) {
            const payout = stake * combinedDec;
            const profit = payout - stake;
            embed.addFields({ name: 'Payout', value: `Stake **$${stake.toFixed(2)}** → **$${payout.toFixed(2)}**  (profit **$${profit.toFixed(2)}**)` });
        } else {
            embed.addFields({ name: 'Payout', value: 'Add a `stake` amount to also see the dollar payout.' });
        }
        embed.setFooter({ text: `${legs.length}-leg parlay` });
        await interaction.reply({ embeds: [embed] });
    }

    // ===== /linehistory — line movement graph, MEMBERS CHAT ONLY, public =====
    if (commandName === 'linehistory') {
        const norm = (interaction.channel?.name || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!norm.includes('memberschat')) {
            return interaction.reply({ content: '📈 The `/linehistory` command can only be used in the members chat.', ephemeral: true });
        }
        const teamQuery = options.getString('team');
        const leagueKey = options.getString('league') || null;
        const statKey = options.getString('stat') || null;
        await interaction.deferReply();
        try {
            // Work out WHAT to chart:
            //  • a stat was picked  -> look up that player prop directly
            //  • otherwise try the team game first; if it's a confident match, use it
            //  • a weak / no team match -> also try player props and keep whichever wins
            let view = null;
            let ambiguous = null;

            if (statKey) {
                const pm = await findKalshiPlayer(teamQuery, leagueKey, statKey);
                if (pm && pm.ambiguous) ambiguous = pm.names;
                else if (pm) view = playerView(pm);
            } else {
                const teamMatch = await findKalshiMarket(teamQuery, leagueKey);
                if (teamMatch && teamMatch.score >= 90) {
                    view = teamView(teamMatch);
                } else {
                    let pm = null;
                    try { pm = await findKalshiPlayer(teamQuery, leagueKey, null); }
                    catch (e) { if (String(e.message).includes('rate')) throw e; }
                    if (pm && pm.ambiguous) ambiguous = pm.names;
                    else if (pm) view = playerView(pm);
                    else if (teamMatch) view = teamView(teamMatch); // weak team match beats nothing
                }
            }

            if (ambiguous) {
                return interaction.editReply(
                    `I found a few players matching **${teamQuery}**: ${ambiguous.map(n => `**${n}**`).join(', ')}.\n` +
                    `Type the full name (first and last) and I'll pull that one.`
                );
            }
            if (!view) {
                return interaction.editReply(
                    `I couldn't find a current line for **${teamQuery}**.\n` +
                    `• For a team, try the name or city — e.g. \`Yankees\`, \`Lakers\`, \`Real Madrid\`.\n` +
                    `• For a player, try their name — e.g. \`Wembanyama\`, \`Salah\` — and pick the **stat** (points, goal, etc.).\n` +
                    `• That league may be off-season, or the game/player isn't listed yet (lines show up a few days before tip-off/kickoff).\n` +
                    `• Tip: pick a **league** in the command to search faster.`
                );
            }

            // Pull this market's price history (= the chance over time).
            const points = await fetchKalshiHistory(view.seriesTicker, view.market.ticker);
            if (points.length === 0) {
                const nowP = currentMarketProb(view.market);
                const nowStr = nowP != null ? `**${Math.round(nowP * 100)}%** (moneyline ${probToMoneyline(nowP)})` : 'not priced yet';
                return interaction.editReply(
                    `Found **${view.event.title}** (${view.leagueName}) but there's no price history yet.\n` +
                    `Current chance for **${view.nowLabel}** ${view.lineNote}: ${nowStr}.\n` +
                    `Check back closer to game time and the movement line will fill in.`
                );
            }

            // Keep the chart readable if there are lots of hourly readings.
            let plot = points;
            if (plot.length > 60) {
                const step = Math.ceil(plot.length / 60);
                plot = points.filter((_, i) => i % step === 0 || i === points.length - 1);
            }
            const labels = plot.map(p => shortTime(p.ts));
            const values = plot.map(p => Math.round(p.prob * 100));
            const first = points[0].prob;
            const latest = points[points.length - 1].prob;

            const chartConfig = {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: view.chartLabel,
                        data: values,
                        fill: false,
                        borderColor: '#00AE86',
                        backgroundColor: '#00AE86',
                        lineTension: 0.2,
                        pointRadius: 2
                    }]
                },
                options: {
                    title: { display: true, text: view.chartTitle },
                    legend: { display: false },
                    scales: { yAxes: [{ ticks: { suggestedMin: 0, suggestedMax: 100 }, scaleLabel: { display: true, labelString: view.axis } }] }
                }
            };

            let imageUrl = null;
            try { imageUrl = await makeChartUrl(chartConfig); }
            catch (e) { console.error('chart error:', e.message); }

            const embed = new EmbedBuilder()
                .setColor(0x00AE86)
                .setTitle(view.embedTitle)
                .setDescription(
                    `${view.line1}\n` +
                    `Now: **${Math.round(latest * 100)}%**  (moneyline **${probToMoneyline(latest)}**)\n` +
                    `Earlier this week: about **${Math.round(first * 100)}%** (${probToMoneyline(first)})\n` +
                    `${points.length} hourly reading${points.length === 1 ? '' : 's'}`
                )
                .setFooter({ text: 'Live odds via Kalshi · refreshed each time you run the command' });
            if (imageUrl) embed.setImage(imageUrl);
            await interaction.editReply({ embeds: [embed] });
        } catch (e) {
            console.error('linehistory command error:', e);
            const msg = String(e.message || '').includes('rate')
                ? 'Kalshi is busy right now (too many requests in a row). Please try again in a few seconds.'
                : 'Something went wrong building the line history. Please try again in a moment.';
            await interaction.editReply(msg);
        }
    }
});

// ====== STRIPE WEBHOOK SERVER ======
async function findMemberByUsername(guild, username) {
    const clean = username.trim().toLowerCase().replace(/^@/, '').split('#')[0];
    await guild.members.fetch();
    return guild.members.cache.find(m => {
        const u = m.user.username.toLowerCase();
        const n = (m.nickname || '').toLowerCase();
        const g = (m.user.globalName || '').toLowerCase();
        return u === clean || n === clean || g === clean;
    });
}

async function assignRoleByUsername(username, customerId) {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const member = await findMemberByUsername(guild, username);
        if (!member) {
            // User hasn't joined the server yet — remember them and assign role when they join
            const key = username.trim().toLowerCase().replace(/^@/, '').split('#')[0];
            await dbSavePending(key, customerId);
            console.log(`User ${username} paid but not in server yet — saved as pending`);
            return;
        }
        await member.roles.add(process.env.DISCORD_ROLE_ID);
        await dbSaveSubscriber(customerId, member.id, member.user.username);
        console.log(`Assigned PAID role to ${member.user.username}`);
        try { await member.send(`Welcome! Your subscription is active and your PAID role has been assigned.`); } catch {}
    } catch (err) {
        console.error('Error assigning role:', err);
    }
}

// When someone joins the server, check if they have a pending paid subscription
client.on('guildMemberAdd', async (member) => {
    try {
        const candidates = [
            member.user.username,
            member.user.globalName,
            member.nickname
        ].filter(Boolean).map(n => n.toLowerCase());

        for (const name of candidates) {
            const customerId = await dbGetPending(name);
            if (customerId) {
                await member.roles.add(process.env.DISCORD_ROLE_ID);
                await dbSaveSubscriber(customerId, member.id, member.user.username);
                await dbDeletePending(name);
                console.log(`New member ${member.user.username} matched pending payment — role assigned`);
                try { await member.send(`Welcome! Your subscription is active and your PAID role has been assigned.`); } catch {}
                return;
            }
        }
    } catch (err) {
        console.error('Error in guildMemberAdd:', err);
    }
});

async function removeRoleAndKick(customerId) {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        let member = null;
        const discordId = await dbGetSubscriber(customerId);

        if (discordId) {
            member = await guild.members.fetch(discordId).catch(() => null);
        }

        // Fallback: look up the customer's checkout session in Stripe to find their Discord username
        if (!member) {
            console.log(`No mapping for customer ${customerId} — querying Stripe...`);
            try {
                const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 1 });
                if (sessions.data.length) {
                    const session = sessions.data[0];
                    let username = null;
                    if (session.custom_fields && session.custom_fields.length) {
                        const field = session.custom_fields.find(f =>
                            (f.key || '').toLowerCase().includes('discord') ||
                            (f.label && f.label.custom && f.label.custom.toLowerCase().includes('discord'))
                        );
                        if (field && field.text) username = field.text.value;
                    }
                    if (username) {
                        member = await findMemberByUsername(guild, username);
                        const key = username.trim().toLowerCase().replace(/^@/, '').split('#')[0];
                        await dbDeletePending(key).catch(() => {});
                    }
                }
            } catch (e) {
                console.error('Stripe lookup failed:', e.message);
            }
        }

        if (member) {
            await member.roles.remove(process.env.DISCORD_ROLE_ID).catch(() => {});
            try { await member.send(`Your subscription has been canceled. You have been removed from the server.`); } catch {}
            await member.kick('Subscription canceled').catch(() => {});
            console.log(`Removed role and kicked ${member.user.username}`);
        } else {
            console.log(`Could not find member to kick for customer ${customerId}`);
        }
        await dbDeleteSubscriber(customerId).catch(() => {});
    } catch (err) {
        console.error('Error removing role:', err);
    }
}

const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerId = session.customer;
        if (customerId && session.id) {
            await dbSaveCheckoutSession(session.id, customerId);
            console.log(`Saved checkout session ${session.id} for customer ${customerId}`);
            const email = (session.customer_details && session.customer_details.email) || session.customer_email;
            if (email) {
                await sendConnectEmail(email, session.id).catch(e => console.error('Email send failed:', e.message));
            } else {
                console.log('No customer email on checkout session — could not send connect link');
            }
        }
    }

    if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        await removeRoleAndKick(sub.customer);
    }

    // Refund or dispute = kick immediately, and also cancel any active subscription
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
        const charge = event.data.object;
        const customerId = charge.customer;
        if (customerId) {
            console.log(`Refund/dispute for customer ${customerId} — canceling subscription and kicking`);
            try {
                const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
                for (const sub of subs.data) {
                    if (sub.status !== 'canceled') {
                        await stripe.subscriptions.cancel(sub.id).catch(e => console.error('Cancel failed:', e.message));
                    }
                }
            } catch (e) {
                console.error('Subscription cancel on refund failed:', e.message);
            }
            await removeRoleAndKick(customerId);
        }
    }

    res.json({ received: true });
});

// ====== DISCORD OAUTH CONNECT FLOW ======
function publicUrl() {
    return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

// Send the "Connect Discord" link by email via Brevo (free, no credit card)
async function sendConnectEmail(toEmail, sessionId) {
    if (!process.env.BREVO_API_KEY || !process.env.FROM_EMAIL) {
        console.log('Brevo not configured (BREVO_API_KEY / FROM_EMAIL) — skipping email');
        return;
    }
    const link = `${publicUrl()}/connect?session_id=${sessionId}`;
    const html = `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2>Thanks for subscribing!</h2>
            <p>Click the button below to connect your Discord account and unlock your access:</p>
            <p style="text-align:center;margin:28px 0">
                <a href="${link}" style="background:#5865F2;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600">Connect Discord</a>
            </p>
            <p style="color:#666;font-size:13px">If the button doesn't work, copy and paste this link into your browser:<br>${link}</p>
        </div>`;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            sender: { email: process.env.FROM_EMAIL, name: '50fifty' },
            to: [{ email: toEmail }],
            subject: 'Connect your Discord to unlock access',
            htmlContent: html
        })
    });
    if (res.status >= 200 && res.status < 300) {
        console.log(`Connect email sent to ${toEmail}`);
    } else {
        const txt = await res.text();
        console.error(`Brevo error ${res.status}:`, txt);
    }
}
function htmlPage(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1115;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
.card{background:#1a1d24;padding:40px;border-radius:12px;max-width:420px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{margin:0 0 12px;font-size:24px}
p{color:#9aa3b2;line-height:1.5;margin:0 0 24px}
a.btn{display:inline-block;background:#5865F2;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px}
a.btn:hover{background:#4752c4}
.success{color:#4ade80}
.error{color:#f87171}
</style></head><body><div class="card">${body}</div></body></html>`;
}

app.get('/connect', async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) {
        // No session id (e.g. plain redirect from Stripe) — point them to their email
        return res.send(htmlPage('Payment received', `
            <h1 class="success">Payment received!</h1>
            <p>Check your email for your personal <strong>Connect Discord</strong> link to unlock your access. It should arrive within a minute.</p>
            <p style="font-size:13px;color:#9aa3b2">Don't see it? Check your spam folder.</p>
        `));
    }
    try {
        const row = await dbGetCheckoutSession(sessionId);
        if (!row) {
            return res.status(404).send(htmlPage('Not found', `<h1 class="error">Payment not found yet</h1><p>Your payment is still processing. Please refresh this page in 30 seconds.</p>`));
        }
        if (row.used) {
            return res.status(409).send(htmlPage('Already used', `<h1 class="error">This link has already been used</h1><p>This access link can only be used once and has already connected a Discord account. If this wasn't you, contact support.</p>`));
        }
        const redirectUri = encodeURIComponent(`${publicUrl()}/oauth/callback`);
        const clientId = process.env.DISCORD_CLIENT_ID;
        const state = encodeURIComponent(sessionId);
        const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify%20guilds.join&state=${state}&prompt=consent`;
        res.send(htmlPage('Connect Discord', `
            <h1>Payment received!</h1>
            <p>Click below to connect your Discord account and unlock your access.</p>
            <a class="btn" href="${url}">Connect Discord</a>
        `));
    } catch (err) {
        console.error('/connect error:', err.message);
        res.status(500).send(htmlPage('Try again', `<h1 class="error">One moment</h1><p>We couldn't load your connect page just now. Please refresh this page in a few seconds.</p>`));
    }
});

app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
        return res.status(400).send(htmlPage('Error', `<h1 class="error">Missing code</h1><p>Something went wrong. Please try the connect link again.</p>`));
    }
    const sessionId = decodeURIComponent(state);

    try {
        const row = await dbGetCheckoutSession(sessionId);
        if (!row) {
            return res.status(404).send(htmlPage('Error', `<h1 class="error">Session expired</h1><p>Please use the link from your Stripe receipt again.</p>`));
        }
        if (row.used) {
            return res.status(409).send(htmlPage('Already used', `<h1 class="error">This link has already been used</h1><p>This access link can only be used once and has already connected a Discord account.</p>`));
        }

        // Exchange code for access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: `${publicUrl()}/oauth/callback`
            })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            console.error('Token exchange failed:', tokenData);
            return res.status(500).send(htmlPage('Error', `<h1 class="error">Connection failed</h1><p>Could not verify your Discord account. Please try again.</p>`));
        }

        // Get user info
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();
        if (!user.id) {
            console.error('User fetch failed:', user);
            return res.status(500).send(htmlPage('Error', `<h1 class="error">Connection failed</h1><p>Could not read your Discord account.</p>`));
        }

        // Atomically claim the link so it can never be reused/shared
        const customerId = await dbClaimCheckoutSession(sessionId);
        if (!customerId) {
            return res.status(409).send(htmlPage('Already used', `<h1 class="error">This link has already been used</h1><p>This access link can only be used once and has already connected a Discord account.</p>`));
        }

        // Add user to guild with PAID role (or update if already a member)
        const guildId = process.env.DISCORD_GUILD_ID;
        const roleId = process.env.DISCORD_ROLE_ID;
        const addRes = await fetch(`https://discord.com/api/guilds/${guildId}/members/${user.id}`, {
            method: 'PUT',
            headers: {
                Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                access_token: tokenData.access_token,
                roles: [roleId]
            })
        });

        if (addRes.status === 204) {
            // Already in server — just add the role
            await fetch(`https://discord.com/api/guilds/${guildId}/members/${user.id}/roles/${roleId}`, {
                method: 'PUT',
                headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
            });
        } else if (!addRes.ok) {
            const errText = await addRes.text();
            console.error('Failed to add member:', addRes.status, errText);
        }

        await dbSaveSubscriber(customerId, user.id, user.username);
        console.log(`Connected ${user.username} (${user.id}) to customer ${customerId}`);

        res.send(htmlPage('Success', `
            <h1 class="success">You're in!</h1>
            <p>Your Discord account is connected and your PAID role is active. You can close this tab and open Discord.</p>
        `));
    } catch (err) {
        console.error('OAuth callback error:', err);
        res.status(500).send(htmlPage('Error', `<h1 class="error">Something went wrong</h1><p>Please try the connect link again.</p>`));
    }
});

const BUILD_MARKER = 'linehistory-players-2026-06-13-1';
app.get('/', (_req, res) => {
    let betSlips = 'unknown';
    try {
        const g = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (!g) {
            betSlips = 'guild-not-cached';
        } else {
            const ch = g.channels.cache.find(c => c.name && c.name.toLowerCase().replace(/[^a-z]/g, '').includes('betslips'));
            betSlips = ch ? { id: ch.id, name: ch.name } : 'not-found';
        }
    } catch (e) {
        betSlips = 'err:' + e.message;
    }
    res.json({
        status: 'FiddyBot is running!',
        build: BUILD_MARKER,
        botReady: client.isReady(),
        botTag: client.user ? client.user.tag : null,
        betSlipsChannel: betSlips
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Webhook server listening on port ${PORT}`));

// ====== LOGIN ======
client.login(process.env.DISCORD_BOT_TOKEN);
