// Buttsbot Clone — Node.js + tmi.js
import dotenv from 'dotenv';
import tmi from 'tmi.js';
dotenv.config();

// --- Configuration ---
const BOT_USERNAME = process.env.TWITCH_USERNAME?.trim();
const OAUTH_TOKEN = process.env.TWITCH_OAUTH?.trim();
const CHANNELS = (process.env.TWITCH_CHANNELS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!BOT_USERNAME || !OAUTH_TOKEN || CHANNELS.length === 0) {
  console.error('Missing env: TWITCH_USERNAME, TWITCH_OAUTH, TWITCH_CHANNELS');
  process.exit(1);
}

const DEFAULTS = {
  word: (process.env.BUTT_WORD || 'butt').toLowerCase(),
  rate: clamp(parseFloat(process.env.BUTT_RATE ?? '0.25'), 0, 1),
  maxReplacements: clamp(parseInt(process.env.MAX_REPLACEMENTS ?? '2', 10), 1, 5),
  enabled: true,
};

// --- Per-channel runtime state ---
const state = new Map(
  CHANNELS.map(ch => [
    ch,
    {
      ...DEFAULTS,
      optOut: new Set(),
      cooldownUntil: 0,
    },
  ])
);

// --- Twitch client ---
const client = new tmi.Client({
  options: { debug: false },
  identity: { username: BOT_USERNAME, password: OAUTH_TOKEN },
  channels: CHANNELS,
  connection: { reconnect: true, secure: true },
});

client.on('message', onMessage);
client.on('connected', (addr, port) => {
  console.log(`[buttsbot-clone] Connected to ${addr}:${port} as @${BOT_USERNAME}`);
});

client.connect().catch(err => {
  console.error('TMI connect error:', err);
  process.exit(1);
});

// --- Message handler ---
async function onMessage(channel, tags, msg, self) {
  if (self) return;

  const ch = channel.replace('#', '').toLowerCase();
  const user = (tags['display-name'] || tags.username || '').toLowerCase();
  const isMod = Boolean(tags.mod) || (tags.badges && tags.badges.broadcaster === '1');

  // Commands
  if (msg.startsWith('!')) {
    await handleCommand(ch, user, isMod, msg.trim(), tags);
    return;
  }

  const cfg = state.get(ch);
  if (!cfg?.enabled || cfg.optOut.has(user)) return;
  if (Math.random() > cfg.rate) return;
  if (Date.now() < cfg.cooldownUntil) return;
  if (shouldSkip(msg)) return;

  const out = buttify(msg, cfg.word, cfg.maxReplacements);
  if (!out || out === msg) return;

  cfg.cooldownUntil = Date.now() + 1500;
  try {
    await client.say(channel, out);
  } catch (e) {
    console.warn('say() failed:', e?.message || e);
  }
}

// --- Commands ---
async function handleCommand(ch, user, isMod, raw, tags) {
  const [cmd, ...rest] = raw.split(/\s+/);
  const cfg = state.get(ch);
  if (!cfg) return;

  switch (cmd.toLowerCase()) {
    case '!buttignore':
      cfg.optOut.add(user);
      await trySay(ch, `@${tags['display-name'] || user} okay, I will not buttify you here.`);
      break;

    case '!buttallow':
      cfg.optOut.delete(user);
      await trySay(ch, `@${tags['display-name'] || user} welcome back to the butts.`);
      break;

    case '!butt':
      const sub = (rest[0] || '').toLowerCase();

      // No argument = show user help
      if (!sub) {
        await trySay(
          ch,
          '!buttallow / !buttignore'
        );
        break;
      }

      // Only mods can change settings
      if (!isMod) return;

      if (sub === 'rate' && rest[1] != null) {
        const v = clamp(parseFloat(rest[1]), 0, 1);
        cfg.rate = isFinite(v) ? v : cfg.rate;
        await trySay(ch, `Butt rate set to ${cfg.rate}.`);
      } else if (sub === 'word' && rest[1]) {
        cfg.word = sanitizeWord(rest.slice(1).join(' ')) || cfg.word;
        await trySay(ch, `Butt word set to "${cfg.word}".`);
      } else if (sub === 'max' && rest[1]) {
        cfg.maxReplacements = clamp(parseInt(rest[1], 10), 1, 5);
        await trySay(ch, `Max replacements set to ${cfg.maxReplacements}.`);
      } else if (sub === 'on' || sub === 'off') {
        cfg.enabled = sub === 'on';
        await trySay(ch, `Buttification ${cfg.enabled ? 'enabled' : 'disabled'}.`);
      } else {
        await trySay(ch, 'Usage: !butt rate <0..1> | word <text> | max <1..5> | on|off');
      }
      break;
  }
}

async function trySay(ch, text) {
  try {
    await client.say(`#${ch}`, text);
  } catch {}
}

// --- Buttification ---
function buttify(message, buttWord = 'butt', maxReplacements = 2) {
  const tokens = tokenize(message);
  const candidates = tokens.map((t, i) => (isWord(t) && isGoodTarget(t, buttWord) ? i : -1)).filter(i => i >= 0);
  if (!candidates.length) return null;

  shuffleInPlace(candidates);

  // Weighted replacement: 90% 1, 5% 2, 3% 3, 1% 4, 1% all
  const r = Math.random();
  let replaceCount;
  if (r < 0.9) replaceCount = 1;
  else if (r < 0.95) replaceCount = Math.min(2, candidates.length);
  else if (r < 0.98) replaceCount = Math.min(3, candidates.length);
  else if (r < 0.99) replaceCount = Math.min(4, candidates.length);
  else replaceCount = candidates.length;

  const toReplace = candidates.slice(0, replaceCount);
  return tokens.map((t, i) => (toReplace.includes(i) ? replaceWord(t, buttWord) : t)).join('').trim();
}

function replaceWord(token, buttWord) {
  const match = token.match(/^([\p{L}\p{M}\p{N}\-']+)([^\p{L}\p{M}\p{N}']*)$/u);
  if (!match) return buttWord;
  const [, core, trail] = match;
  return styleLike(core, buttWord) + (trail || '');
}

function styleLike(source, word) {
  if (source.toUpperCase() === source && /[A-Z]/.test(source)) return word.toUpperCase();
  if (source[0] && source[0] === source[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word.toLowerCase();
}

function tokenize(s) {
  return s.match(/([\p{L}\p{M}\p{N}\-']+|[^\p{L}\p{M}\p{N}\-']+)/gu) || [s];
}

function isWord(token) {
  return /[\p{L}\p{M}\p{N}]/u.test(token);
}

function isGoodTarget(token) {
  const t = token.trim().toLowerCase();
  if (!t || t.length <= 1 || t.includes(DEFAULTS.word)) return false;
  if (t.startsWith('@') || t.startsWith(':')) return false;
  if (URL_RE.test(t)) return false;
  if (t.includes('http') || t.includes('www.')) return false;
  return true;
}

const URL_RE = /\b((?:https?:\/\/)?(?:[\w-]+\.)+[\w-]{2,})(?:\/[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/i;

function sanitizeWord(s) {
  return (s || '').trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\-']/gu, '').slice(0, 24);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function shouldSkip(msg) {
  if (!msg || msg.trim().length < 3) return true;
  if (msg.trim().startsWith('!')) return true;
  if (msg.includes('http://') || msg.includes('https://') || msg.includes('www.')) return true;
  if (/^[^a-z]*$/i.test(msg.trim())) return true;
  return false;
}

// --- Graceful shutdown ---
process.on('SIGINT', () => console.log('\nShutting down...') || process.exit(0));
process.on('SIGTERM', () => console.log('Shutting down...') || process.exit(0));
