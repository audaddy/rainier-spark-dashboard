import { sendPush } from './push.js';

const GAMES = new Set(['sparkle', 'zip', 'snake']);
const MAX_ENTRIES = 25;
const MAX_NAME_LEN = 20;

// Squadron affiliation for unit-vs-unit standings. Keep in sync with index.html.
const SQUADRONS = new Set(['62 OG', '62 MXG', '62 MXS', '62 APS', '62 AMXS', '446 AW', 'OSS', 'CES', 'FSS', 'Other']);
function sanitizeSquadron(raw) {
  const s = String(raw || '').trim();
  return SQUADRONS.has(s) ? s : null;
}

const DEFAULT_ORIGIN = 'https://audaddy.github.io';
const ALLOWED_ORIGINS = [/^https:\/\/audaddy\.github\.io$/, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'retard'];

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.some((re) => re.test(origin)) ? origin : DEFAULT_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    Vary: 'Origin',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function sanitizeName(raw) {
  let name = String(raw || 'Anonymous').trim().slice(0, MAX_NAME_LEN);
  name = name.replace(/[<>"'&]/g, '');
  if (!name) name = 'Anonymous';
  const lower = name.toLowerCase();
  if (PROFANITY.some((word) => lower.includes(word))) name = 'Anonymous';
  return name;
}

function sortEntries(game, entries) {
  if (game === 'sparkle') {
    return entries.slice().sort((a, b) => a.guesses - b.guesses || a.ms - b.ms);
  }
  if (game === 'snake') {
    return entries.slice().sort((a, b) => b.score - a.score);
  }
  return entries.slice().sort((a, b) => a.timeMs - b.timeMs);
}

function validScore(game, score) {
  if (game === 'sparkle') return Number.isFinite(score.guesses) && Number.isFinite(score.ms);
  if (game === 'snake') return Number.isFinite(score.score);
  return Number.isFinite(score.timeMs);
}

// Copy ONLY the numeric fields this game uses. Never spread the caller's score
// object into a stored entry: validScore checks that the expected numbers are
// present but does not reject extra keys, so a spread lets the client smuggle in
// its own `name` / `clientId` / `squadron` and clobber the sanitized values.
function pickScore(game, score) {
  if (game === 'sparkle') return { guesses: Number(score.guesses), ms: Number(score.ms) || 0 };
  if (game === 'snake') return { score: Number(score.score) };
  return { timeMs: Number(score.timeMs) };
}

// clientId is only ever compared for equality, so a bounded string is enough.
function sanitizeClientId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().slice(0, 64);
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

function isBetter(game, a, b) {
  if (game === 'sparkle') return a.guesses < b.guesses || (a.guesses === b.guesses && (a.ms || 0) < (b.ms || 0));
  if (game === 'snake') return a.score > b.score;
  return a.timeMs < b.timeMs;
}

function redact(entries) {
  return entries.map(({ clientId, ...rest }) => rest);
}

async function handleGet(url, env, origin) {
  const game = url.searchParams.get('game');
  const period = url.searchParams.get('period');
  if (!GAMES.has(game) || !period) {
    return json({ error: 'invalid game or period' }, 400, origin);
  }
  const raw = await env.LEADERBOARD_KV.get(`${game}:${period}`);
  const entries = raw ? JSON.parse(raw) : [];
  return json({ leaderboard: redact(sortEntries(game, entries).slice(0, MAX_ENTRIES)) }, 200, origin);
}

async function handlePost(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'invalid JSON body' }, 400, origin);
  }

  const { game, period, name, score, clientId, squadron } = body || {};
  if (!GAMES.has(game) || !period || typeof score !== 'object' || score === null || !validScore(game, score)) {
    return json({ error: 'invalid payload' }, 400, origin);
  }
  const sq = sanitizeSquadron(squadron);
  const cid = sanitizeClientId(clientId);

  const key = `${game}:${period}`;
  const raw = await env.LEADERBOARD_KV.get(key);
  const entries = raw ? JSON.parse(raw) : [];

  // Score fields first, sanitized fields last, so nothing the client sends can
  // override the sanitized name/clientId/squadron.
  const entry = {
    ...pickScore(game, score),
    name: sanitizeName(name),
    clientId: cid,
    ...(sq ? { squadron: sq } : {}),
  };
  // one row per player: resubmits from the same client keep their best score
  const existing = cid ? entries.findIndex((e) => e.clientId === cid) : -1;
  if (existing !== -1) {
    if (isBetter(game, entry, entries[existing])) entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  const sorted = sortEntries(game, entries).slice(0, MAX_ENTRIES);

  await env.LEADERBOARD_KV.put(key, JSON.stringify(sorted));
  return json({ leaderboard: redact(sorted) }, 200, origin);
}

// ── Click tracking + anonymous unique-visitor analytics ──
const EVENTS_KEY = 'events:v1';
const EVENT_NAME_RE = /^[a-z0-9_]{1,40}$/;
const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;      // anonymous browser token (no PII)
const MAX_EVENT_NAMES = 100;
const MAX_EVENT_DAYS = 120;
const MAX_VISITORS = 20000;                  // cap the visitor registry size
const MAX_VISITOR_DAYS = 90;                 // per-visitor active-day history

function utcDay() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Read the analytics blob, migrating the old flat { [name]: {...} } shape into
// the { actions, visitors } structure so existing data is preserved.
async function loadAnalytics(env) {
  const raw = await env.LEADERBOARD_KV.get(EVENTS_KEY);
  const data = raw ? JSON.parse(raw) : null;
  if (!data) return { actions: {}, visitors: {} };
  if (!data.actions) return { actions: data, visitors: {} }; // legacy → migrate
  if (!data.visitors) data.visitors = {};
  return data;
}

async function handleEvent(request, env, origin) {
  let name = '';
  let vid = null;
  try {
    const body = JSON.parse(await request.text());
    if (body && typeof body.name === 'string') name = body.name;
    if (body && typeof body.vid === 'string' && VID_RE.test(body.vid)) vid = body.vid;
  } catch (e) {
    return json({ error: 'invalid body' }, 400, origin);
  }
  if (!EVENT_NAME_RE.test(name)) {
    return json({ error: 'invalid name' }, 400, origin);
  }

  const data = await loadAnalytics(env);
  const day = utcDay();

  // ── Click counts per action (unchanged semantics) ──
  const actions = data.actions;
  if (!actions[name]) {
    if (Object.keys(actions).length >= MAX_EVENT_NAMES) {
      return json({ ok: false }, 200, origin); // ignore new names past the cap
    }
    actions[name] = { total: 0, days: {} };
  }
  actions[name].total = (actions[name].total || 0) + 1;
  actions[name].days[day] = (actions[name].days[day] || 0) + 1;
  const adays = Object.keys(actions[name].days).sort();
  if (adays.length > MAX_EVENT_DAYS) {
    for (const d of adays.slice(0, adays.length - MAX_EVENT_DAYS)) delete actions[name].days[d];
  }

  // ── Per-visitor registry (anonymous device token) ──
  if (vid) {
    let v = data.visitors[vid];
    if (!v) {
      if (Object.keys(data.visitors).length < MAX_VISITORS) {
        v = data.visitors[vid] = { first: day, last: day, days: {}, actions: {} };
      }
    }
    if (v) {
      v.last = day;
      if (!v.first) v.first = day;
      v.days[day] = (v.days[day] || 0) + 1;
      v.actions[name] = (v.actions[name] || 0) + 1;
      const vdays = Object.keys(v.days).sort();
      if (vdays.length > MAX_VISITOR_DAYS) {
        for (const d of vdays.slice(0, vdays.length - MAX_VISITOR_DAYS)) delete v.days[d];
      }
    }
  }

  await env.LEADERBOARD_KV.put(EVENTS_KEY, JSON.stringify(data));
  return json({ ok: true }, 200, origin);
}

// Aggregate the visitor registry into compact metrics (payload stays small
// regardless of how many visitors are stored).
function computePeople(visitors) {
  const vids = Object.keys(visitors);
  const today = utcDay();
  const window7 = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    window7.add(d.toISOString().slice(0, 10));
  }
  const daily = {};             // day → unique visitors active
  const perAction = {};         // action → unique visitors who clicked it
  const perActionClicks = {};   // action → clicks from tracked visitors
  let dauToday = 0, active7 = 0, newToday = 0, trackedClicks = 0;

  for (const vid of vids) {
    const v = visitors[vid];
    const vdays = Object.keys(v.days || {});
    for (const d of vdays) daily[d] = (daily[d] || 0) + 1;
    if (v.days && v.days[today]) dauToday++;
    if (vdays.some((d) => window7.has(d))) active7++;
    if (v.first === today) newToday++;
    for (const a in (v.actions || {})) {
      perAction[a] = (perAction[a] || 0) + 1;
      perActionClicks[a] = (perActionClicks[a] || 0) + v.actions[a];
      trackedClicks += v.actions[a];
    }
  }
  return {
    uniqueTotal: vids.length,
    dauToday,
    active7,
    newToday,
    returningToday: Math.max(0, dauToday - newToday),
    avgClicksPerVisitor: vids.length ? +(trackedClicks / vids.length).toFixed(1) : 0,
    perAction,
    perActionClicks,
    daily,
  };
}

async function handleStats(request, env, origin) {
  const key = request.headers.get('X-Admin-Key');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 401, origin);
  }
  const data = await loadAnalytics(env);
  return json({ events: data.actions, people: computePeople(data.visitors) }, 200, origin);
}

// ── Web Push subscriptions ──
const SUBS_KEY = 'push:subs:v1';
const MAX_SUBS = 2000;
const SITE_URL = 'https://audaddy.github.io/rainier-spark-dashboard/';

// Daily nudge copy — rotated by day so it doesn't get tuned out. {{n}} = puzzle #.
const DAILY_NUDGES = [
  "Today's Sparkle is live. Solve it before the flight line does.",
  'Fresh Sparkle + Zip are up. Two minutes, one shot.',
  'Daily puzzle deployed. Keep the streak alive.',
  "Today's word is waiting. Beat your squadron to it.",
  'Sparkle #{{n}} just dropped. Can you clear it in 3?',
];
// Streak-at-risk copy — {{n}} = that user's current streak.
const ATRISK_NUDGES = [
  'Your {{n}}-day streak ends at midnight. One puzzle saves it.',
  '{{n}} days and counting — play today to keep it going.',
  'Your streak resets tonight. Two minutes to protect it.',
];

function pick(arr, seed) { return arr[((seed % arr.length) + arr.length) % arr.length]; }

// Sparkle puzzle number — mirrors the frontend dayIndex() (epoch 2026-01-01 UTC).
function sparkleNumber() {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - Date.UTC(2026, 0, 1)) / 86400000) + 1;
}

// Calendar day (YYYY-MM-DD) in the audience's timezone (McChord ≈ Pacific),
// optionally offset by N days back.
function pacificDay(daysBack = 0) {
  const d = new Date(Date.now() - daysBack * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}

// Return the public VAPID key so the browser can subscribe.
function handleVapid(env, origin) {
  return json({ key: env.VAPID_PUBLIC_KEY || null }, 200, origin);
}

// Store a PushSubscription (deduped by endpoint).
async function handleSubscribe(request, env, origin) {
  let sub;
  try { sub = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400, origin); }
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) {
    return json({ error: 'invalid subscription' }, 400, origin);
  }
  // Streak state (optional) lets the evening cron target only at-risk users.
  const streak = Number.isFinite(sub.streak) ? Math.max(0, Math.floor(sub.streak)) : 0;
  const lastPlayed = typeof sub.lastPlayed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sub.lastPlayed) ? sub.lastPlayed : null;
  const raw = await env.LEADERBOARD_KV.get(SUBS_KEY);
  const subs = raw ? JSON.parse(raw) : [];
  const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
  const record = { endpoint: sub.endpoint, keys: sub.keys || null, ts: Date.now(), streak, lastPlayed };
  if (i !== -1) subs[i] = record;
  else if (subs.length < MAX_SUBS) subs.push(record);
  await env.LEADERBOARD_KV.put(SUBS_KEY, JSON.stringify(subs));
  return json({ ok: true, count: subs.length }, 200, origin);
}

// Send a notification to stored subscriptions; prune ones the push service
// reports as gone (404/410). `build` is either a { title, body, url } object or
// a (sub) => payload function (for per-user text). `filter` narrows the target
// set; non-targets are preserved untouched. Returns counts.
async function broadcastPush(env, build, filter) {
  if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) {
    return { error: 'push not configured', sent: 0, pruned: 0, total: 0, targeted: 0 };
  }
  const raw = await env.LEADERBOARD_KV.get(SUBS_KEY);
  const subs = raw ? JSON.parse(raw) : [];
  const alive = [];
  let sent = 0, pruned = 0, targeted = 0;
  for (const sub of subs) {
    if (filter && !filter(sub)) { alive.push(sub); continue; }
    targeted++;
    const payload = typeof build === 'function' ? build(sub) : build;
    try {
      const res = await sendPush(sub, JSON.stringify(payload), env);
      if (res.status === 404 || res.status === 410) { pruned++; continue; }
      alive.push(sub);
      if (res.ok) sent++;
    } catch (e) { alive.push(sub); }
  }
  if (pruned) await env.LEADERBOARD_KV.put(SUBS_KEY, JSON.stringify(alive));
  return { sent, pruned, total: subs.length, targeted };
}

// Admin-triggered broadcast (X-Admin-Key). Body: { title, body, url }.
async function handlePushSend(request, env, origin) {
  const key = request.headers.get('X-Admin-Key');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized' }, 401, origin);
  }
  let payload;
  try { payload = await request.json(); } catch (e) { payload = {}; }
  const msg = {
    title: (payload && payload.title) || 'Rainier Spark',
    body: (payload && payload.body) || "Today's puzzle is live.",
    url: (payload && payload.url) || 'https://audaddy.github.io/rainier-spark-dashboard/',
  };
  const result = await broadcastPush(env, msg);
  return json(result, result.error ? 400 : 200, origin);
}

export default {
  // Two cron triggers (see wrangler.toml), distinguished by event.cron:
  //   "0 15 * * *" → morning: daily puzzle-live nudge (everyone)
  //   "0 2 * * *"  → evening: streak-at-risk nudge (only mid-streak users)
  async scheduled(event, env, ctx) {
    const daySeed = Math.floor(Date.now() / 86400000);

    if (event.cron === '0 2 * * *') {
      const yesterday = pacificDay(1);
      ctx.waitUntil(
        broadcastPush(
          env,
          (s) => ({
            title: "Don't break the chain 🔥",
            body: pick(ATRISK_NUDGES, daySeed).replace('{{n}}', s.streak),
            url: SITE_URL,
          }),
          // Played yesterday but not yet today → exactly one day from losing it.
          (s) => s.streak > 0 && s.lastPlayed === yesterday
        )
      );
      return;
    }

    // Default: daily puzzle-live nudge to everyone.
    const n = sparkleNumber();
    ctx.waitUntil(
      broadcastPush(env, {
        title: 'Rainier Spark',
        body: pick(DAILY_NUDGES, daySeed).replace('{{n}}', n),
        url: SITE_URL,
      })
    );
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/push/vapid') {
      if (request.method === 'GET') return handleVapid(env, origin);
      return json({ error: 'method not allowed' }, 405, origin);
    }
    if (url.pathname === '/push/subscribe') {
      if (request.method === 'POST') return handleSubscribe(request, env, origin);
      return json({ error: 'method not allowed' }, 405, origin);
    }
    if (url.pathname === '/push/send') {
      if (request.method === 'POST') return handlePushSend(request, env, origin);
      return json({ error: 'method not allowed' }, 405, origin);
    }

    if (url.pathname === '/leaderboard') {
      if (request.method === 'GET') return handleGet(url, env, origin);
      if (request.method === 'POST') return handlePost(request, env, origin);
      return json({ error: 'method not allowed' }, 405, origin);
    }
    if (url.pathname === '/event') {
      if (request.method === 'POST') return handleEvent(request, env, origin);
      return json({ error: 'method not allowed' }, 405, origin);
    }
    if (url.pathname === '/stats') {
      if (request.method === 'GET') return handleStats(request, env, origin);
      return json({ error: 'method not allowed' }, 405, origin);
    }
    return json({ error: 'not found' }, 404, origin);
  },
};
