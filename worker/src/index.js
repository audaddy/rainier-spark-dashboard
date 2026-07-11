const GAMES = new Set(['sparkle', 'zip']);
const MAX_ENTRIES = 25;
const MAX_NAME_LEN = 20;

const DEFAULT_ORIGIN = 'https://audaddy.github.io';
const ALLOWED_ORIGINS = [/^https:\/\/audaddy\.github\.io$/, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const PROFANITY = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot', 'retard'];

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.some((re) => re.test(origin)) ? origin : DEFAULT_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
  return entries.slice().sort((a, b) => a.timeMs - b.timeMs);
}

function validScore(game, score) {
  if (game === 'sparkle') return Number.isFinite(score.guesses) && Number.isFinite(score.ms);
  return Number.isFinite(score.timeMs);
}

function isBetter(game, a, b) {
  if (game === 'sparkle') return a.guesses < b.guesses || (a.guesses === b.guesses && (a.ms || 0) < (b.ms || 0));
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

  const { game, period, name, score, clientId } = body || {};
  if (!GAMES.has(game) || !period || typeof score !== 'object' || score === null || !validScore(game, score)) {
    return json({ error: 'invalid payload' }, 400, origin);
  }

  const key = `${game}:${period}`;
  const raw = await env.LEADERBOARD_KV.get(key);
  const entries = raw ? JSON.parse(raw) : [];

  const entry = { name: sanitizeName(name), clientId: clientId || null, ...score };
  // one row per player: resubmits from the same client keep their best score
  const existing = clientId ? entries.findIndex((e) => e.clientId === clientId) : -1;
  if (existing !== -1) {
    if (isBetter(game, entry, entries[existing])) entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  const sorted = sortEntries(game, entries).slice(0, MAX_ENTRIES);

  await env.LEADERBOARD_KV.put(key, JSON.stringify(sorted));
  return json({ leaderboard: redact(sorted) }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname !== '/leaderboard') {
      return json({ error: 'not found' }, 404, origin);
    }
    if (request.method === 'GET') {
      return handleGet(url, env, origin);
    }
    if (request.method === 'POST') {
      return handlePost(request, env, origin);
    }
    return json({ error: 'method not allowed' }, 405, origin);
  },
};
