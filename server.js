#!/usr/bin/env node
/**
 * Pantry Pal — a self-hosted MCP server for Alexa+.
 *
 * Transport : MCP Streamable HTTP (single POST /mcp endpoint, JSON responses)
 * Spec      : 2025-11-25 (also negotiates 2025-06-18 and 2025-03-26)
 * Deps      : none (Node 18+ built-ins only)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER_INFO = { name: 'pantry-pal', title: 'Pantry Pal', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.PANTRY_DATA || path.join(__dirname, 'data', 'pantry.json');
const AUTH_TOKEN = process.env.PANTRY_TOKEN || ''; // optional bearer token
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

// ───────────────────────────── storage ─────────────────────────────

function load() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { pantry: db.pantry || [], shopping: db.shopping || [] };
  } catch {
    return { pantry: [], shopping: [] };
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic replace
}

// ───────────────────────────── helpers ─────────────────────────────

const DAY = 86_400_000;
const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const isoDate = (d) => d.toISOString().slice(0, 10);
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

function daysUntil(iso) {
  if (!iso) return null;
  return Math.round((new Date(`${iso}T00:00:00`) - todayStart()) / DAY);
}

function say(n, unit, name) {
  const u = unit ? `${unit} of ` : '';
  return `${n} ${u}${name}`;
}

function describeExpiry(iso) {
  const d = daysUntil(iso);
  if (d === null) return 'no expiry date';
  if (d < 0) return `expired ${-d} day${d === -1 ? '' : 's'} ago`;
  if (d === 0) return 'expires today';
  if (d === 1) return 'expires tomorrow';
  return `expires in ${d} days`;
}

function joinSpoken(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function findItem(db, name) {
  const q = norm(name);
  return db.pantry.find((i) => i.name === q)
    || db.pantry.find((i) => i.name.includes(q) || q.includes(i.name));
}

// ───────────────────────────── recipes ─────────────────────────────

const RECIPES = [
  { name: 'veggie omelette', needs: ['eggs', 'onion', 'cheese'], minutes: 10 },
  { name: 'tomato pasta', needs: ['pasta', 'tomato', 'garlic'], minutes: 20 },
  { name: 'fried rice', needs: ['rice', 'eggs', 'onion'], minutes: 15 },
  { name: 'grilled cheese sandwich', needs: ['bread', 'cheese', 'butter'], minutes: 8 },
  { name: 'dal and rice', needs: ['lentils', 'rice', 'onion'], minutes: 35 },
  { name: 'banana pancakes', needs: ['banana', 'flour', 'eggs', 'milk'], minutes: 20 },
  { name: 'chicken stir fry', needs: ['chicken', 'onion', 'rice'], minutes: 25 },
  { name: 'potato curry', needs: ['potato', 'onion', 'tomato'], minutes: 30 },
  { name: 'yogurt parfait', needs: ['yogurt', 'banana'], minutes: 5 },
  { name: 'tomato soup', needs: ['tomato', 'onion', 'butter'], minutes: 25 },
];

function have(db, ingredient) {
  return db.pantry.some((i) => i.quantity > 0 && (i.name.includes(ingredient) || ingredient.includes(i.name)));
}

// ───────────────────────────── tools ─────────────────────────────
// Each tool returns { text, data }. `text` is written to be read aloud by Alexa+.

const str = (description) => ({ type: 'string', description });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });

const TOOLS = [
  {
    name: 'add_item',
    title: 'Add pantry item',
    description: 'Add food to the household pantry, e.g. "I just bought a dozen eggs, they expire in 10 days". If the item already exists the quantity is increased.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Food name, singular or plural, e.g. "eggs" or "milk".'),
        quantity: num('How many. Defaults to 1.', { minimum: 0.01 }),
        unit: str('Optional unit such as "litres", "packs" or "dozen".'),
        expires_in_days: num('Days from today until it expires.', { minimum: 0 }),
        expires_on: str('Expiry date as YYYY-MM-DD. Overrides expires_in_days.'),
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run(db, a) {
      const name = norm(a.name);
      const qty = a.quantity ?? 1;
      let expires = null;
      if (a.expires_on) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a.expires_on) || Number.isNaN(Date.parse(a.expires_on))) {
          throw new ToolError('expires_on must be a real date formatted YYYY-MM-DD.');
        }
        expires = a.expires_on;
      } else if (a.expires_in_days !== undefined) {
        expires = isoDate(new Date(todayStart().getTime() + Math.round(a.expires_in_days) * DAY + 12 * 3_600_000));
      }
      let item = db.pantry.find((i) => i.name === name && (a.unit || '') === (i.unit || ''));
      if (item) {
        item.quantity += qty;
        if (expires) item.expires = expires;
      } else {
        item = { name, quantity: qty, unit: a.unit || '', expires, added: isoDate(new Date()) };
        db.pantry.push(item);
      }
      db.shopping = db.shopping.filter((s) => s !== name); // bought it, so drop from the list
      const tail = item.expires ? `, ${describeExpiry(item.expires)}` : '';
      return { text: `Added ${say(qty, a.unit, name)}${tail}. You now have ${say(item.quantity, item.unit, name)}.`, data: { item } };
    },
  },
  {
    name: 'list_pantry',
    title: 'List pantry',
    description: 'Read out what is currently in the pantry. Optionally filter by a search word.',
    inputSchema: { type: 'object', properties: { search: str('Optional food name to filter by, e.g. "milk".') } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run(db, a) {
      const q = a.search ? norm(a.search) : '';
      const items = db.pantry.filter((i) => i.quantity > 0 && (!q || i.name.includes(q)));
      if (!items.length) return { text: q ? `I couldn't find any ${q} in the pantry.` : 'The pantry is empty.', data: { items: [] } };
      const spoken = items.map((i) => say(i.quantity, i.unit, i.name));
      return { text: `You have ${items.length} item${items.length === 1 ? '' : 's'}: ${joinSpoken(spoken)}.`, data: { items } };
    },
  },
  {
    name: 'expiring_soon',
    title: 'Check what is expiring',
    description: 'Tell the user which pantry items expire within a number of days (default 3) or have already expired. Use for "what should I eat first?".',
    inputSchema: { type: 'object', properties: { within_days: num('Look-ahead window in days. Defaults to 3.', { minimum: 0 }) } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run(db, a) {
      const win = a.within_days ?? 3;
      const hits = db.pantry
        .filter((i) => i.quantity > 0 && i.expires && daysUntil(i.expires) <= win)
        .sort((x, y) => daysUntil(x.expires) - daysUntil(y.expires));
      if (!hits.length) return { text: `Nothing is expiring in the next ${win} days. Nice work.`, data: { items: [] } };
      const spoken = hits.map((i) => `${i.name} ${describeExpiry(i.expires)}`);
      return { text: `Heads up: ${joinSpoken(spoken)}.`, data: { items: hits.map((i) => ({ ...i, days_left: daysUntil(i.expires) })) } };
    },
  },
  {
    name: 'use_item',
    title: 'Use up pantry item',
    description: 'Record that some of an item was used or eaten. Removes it when none is left and offers to put it on the shopping list.',
    inputSchema: {
      type: 'object',
      properties: { name: str('Food name.'), quantity: num('How much was used. Defaults to 1.', { minimum: 0.01 }) },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run(db, a) {
      const item = findItem(db, a.name);
      if (!item) throw new ToolError(`There's no ${norm(a.name)} in the pantry.`);
      const used = Math.min(a.quantity ?? 1, item.quantity);
      item.quantity = Math.round((item.quantity - used) * 100) / 100;
      if (item.quantity <= 0) {
        db.pantry = db.pantry.filter((i) => i !== item);
        return { text: `Used the last of the ${item.name}. Want me to add it to your shopping list?`, data: { removed: item.name, ask_shopping_list: true } };
      }
      return { text: `Done. ${say(item.quantity, item.unit, item.name)} left.`, data: { item } };
    },
  },
  {
    name: 'suggest_meals',
    title: 'Suggest meals',
    description: 'Suggest meals the user can cook with what is in the pantry, prioritising ingredients that expire soonest. Also reports what is missing for near-matches.',
    inputSchema: { type: 'object', properties: { max_results: num('How many ideas to return. Defaults to 3.', { minimum: 1, maximum: 5 }) } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run(db, a) {
      const limit = Math.round(a.max_results ?? 3);
      const scored = RECIPES.map((r) => {
        const missing = r.needs.filter((n) => !have(db, n));
        const urgency = r.needs.reduce((sum, n) => {
          const it = db.pantry.find((i) => i.quantity > 0 && i.expires && (i.name.includes(n) || n.includes(i.name)));
          const d = it ? daysUntil(it.expires) : null;
          return sum + (d !== null && d <= 3 ? 4 - Math.max(d, 0) : 0);
        }, 0);
        return { ...r, missing, urgency };
      });
      const cookable = scored.filter((r) => !r.missing.length).sort((x, y) => y.urgency - x.urgency || x.minutes - y.minutes);
      const almost = scored.filter((r) => r.missing.length === 1).sort((x, y) => y.urgency - x.urgency);
      if (!cookable.length && !almost.length) {
        return { text: "I can't match a meal yet. Add a few staples like eggs, rice or tomatoes and ask again.", data: { cookable: [], almost: [] } };
      }
      const parts = [];
      if (cookable.length) {
        const top = cookable.slice(0, limit);
        parts.push(`You can make ${joinSpoken(top.map((r) => `${r.name}, about ${r.minutes} minutes`))}.`);
        if (top[0].urgency > 0) parts.push(`${top[0].name} uses ingredients that are about to expire.`);
      }
      if (almost.length) {
        const a1 = almost[0];
        parts.push(`You're one ingredient short of ${a1.name}: you need ${a1.missing[0]}.`);
      }
      return { text: parts.join(' '), data: { cookable: cookable.slice(0, limit), almost: almost.slice(0, limit) } };
    },
  },
  {
    name: 'shopping_list',
    title: 'Shopping list',
    description: 'Show, add to, remove from, or clear the shopping list.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['show', 'add', 'remove', 'clear'], description: 'What to do. Defaults to show.' },
        item: str('Item name for add or remove.'),
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(db, a) {
      const action = a.action || 'show';
      const item = a.item ? norm(a.item) : '';
      if ((action === 'add' || action === 'remove') && !item) throw new ToolError(`Tell me which item to ${action}.`);
      if (action === 'add') {
        if (!db.shopping.includes(item)) db.shopping.push(item);
        return { text: `Added ${item} to your shopping list. ${db.shopping.length} item${db.shopping.length === 1 ? '' : 's'} on the list.`, data: { shopping: db.shopping } };
      }
      if (action === 'remove') {
        const before = db.shopping.length;
        db.shopping = db.shopping.filter((s) => s !== item);
        return { text: before === db.shopping.length ? `${item} wasn't on the list.` : `Removed ${item} from the list.`, data: { shopping: db.shopping } };
      }
      if (action === 'clear') { db.shopping = []; return { text: 'Shopping list cleared.', data: { shopping: [] } }; }
      if (action !== 'show') throw new ToolError('Action must be show, add, remove or clear.');
      return {
        text: db.shopping.length ? `Your shopping list has ${joinSpoken(db.shopping)}.` : 'Your shopping list is empty.',
        data: { shopping: db.shopping },
      };
    },
  },
];

class ToolError extends Error {}

function validate(schema, args) {
  const props = schema.properties || {};
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') throw new ToolError(`Missing required argument: ${key}.`);
  }
  for (const [key, val] of Object.entries(args)) {
    const p = props[key];
    if (!p) continue;
    if (p.type === 'string' && typeof val !== 'string') throw new ToolError(`${key} must be text.`);
    if (p.type === 'number') {
      if (typeof val !== 'number' || !Number.isFinite(val)) throw new ToolError(`${key} must be a number.`);
      if (p.minimum !== undefined && val < p.minimum) throw new ToolError(`${key} must be at least ${p.minimum}.`);
      if (p.maximum !== undefined && val > p.maximum) throw new ToolError(`${key} must be at most ${p.maximum}.`);
    }
    if (p.enum && !p.enum.includes(val)) throw new ToolError(`${key} must be one of: ${p.enum.join(', ')}.`);
  }
}

function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  try {
    validate(tool.inputSchema, args);
    const db = load();
    const { text, data } = tool.run(db, args);
    save(db);
    return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
  } catch (err) {
    if (err instanceof ToolError) return { content: [{ type: 'text', text: err.message }], isError: true }; // tool-execution error, model can self-correct
    throw err;
  }
}

// ───────────────────────────── JSON-RPC / MCP ─────────────────────────────

const ERR = { PARSE: -32700, INVALID: -32600, NOT_FOUND: -32601, PARAMS: -32602, INTERNAL: -32603 };
const sessions = new Set();

function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

/** Returns a response object, or null for notifications / responses. */
function dispatch(msg, ctx) {
  const isRequest = msg && typeof msg.method === 'string' && msg.id !== undefined;
  const isNotification = msg && typeof msg.method === 'string' && msg.id === undefined;
  if (!msg || msg.jsonrpc !== '2.0' || (!isRequest && !isNotification)) {
    // A JSON-RPC response from the client (e.g. to a server request) — we send none, so just accept it.
    if (msg && msg.jsonrpc === '2.0' && msg.id !== undefined && ('result' in msg || 'error' in msg)) return null;
    return rpcError(msg && msg.id, ERR.INVALID, 'Invalid JSON-RPC message.');
  }
  if (isNotification) return null;

  const { id, method } = msg;
  const params = msg.params || {};
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION;
      ctx.newSession = crypto.randomUUID();
      sessions.add(ctx.newSession);
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'Pantry Pal tracks a household pantry. Keep replies short and speakable: the `text` content is written to be read aloud. Ask before adding to the shopping list.',
        },
      };
    }
    case 'ping': return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: { tools: TOOLS.map(({ run, ...t }) => t) },
      };
    case 'tools/call': {
      if (typeof params.name !== 'string') return rpcError(id, ERR.PARAMS, 'params.name is required.');
      const args = params.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, ERR.PARAMS, 'params.arguments must be an object.');
      const result = callTool(params.name, args);
      if (!result) return rpcError(id, ERR.PARAMS, `Unknown tool: ${params.name}`);
      return { jsonrpc: '2.0', id, result };
    }
    default:
      return rpcError(id, ERR.NOT_FOUND, `Method not found: ${method}`);
  }
}

// ───────────────────────────── HTTP transport ─────────────────────────────

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(payload ? { 'Content-Type': 'application/json' } : {}),
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function originAllowed(origin) {
  if (!origin) return true; // non-browser clients send no Origin
  try {
    const u = new URL(origin);
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
  } catch { return false; }
  return EXTRA_ORIGINS.includes(origin);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') return send(res, 200, { ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version });
  if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found. MCP endpoint is /mcp.' });

  if (!originAllowed(req.headers.origin)) return send(res, 403, rpcError(null, ERR.INVALID, 'Origin not allowed.'));
  if (AUTH_TOKEN && req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
    return send(res, 401, rpcError(null, ERR.INVALID, 'Unauthorized.'), { 'WWW-Authenticate': 'Bearer' });
  }

  const sid = req.headers['mcp-session-id'];
  const ver = req.headers['mcp-protocol-version'];
  if (ver && !SUPPORTED_VERSIONS.includes(ver)) return send(res, 400, rpcError(null, ERR.INVALID, `Unsupported MCP-Protocol-Version: ${ver}`));

  if (req.method === 'DELETE') {
    if (sid && sessions.delete(sid)) return send(res, 204);
    return send(res, 404, rpcError(null, ERR.INVALID, 'Unknown session.'));
  }
  if (req.method === 'GET') return send(res, 405, rpcError(null, ERR.INVALID, 'This server does not offer a standalone SSE stream.'), { Allow: 'POST, DELETE' });
  if (req.method !== 'POST') return send(res, 405, rpcError(null, ERR.INVALID, 'Method not allowed.'), { Allow: 'POST, DELETE' });

  const accept = req.headers.accept || '';
  if (accept && !/application\/json|\*\/\*/.test(accept)) return send(res, 406, rpcError(null, ERR.INVALID, 'Client must accept application/json.'));

  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { return send(res, 400, rpcError(null, ERR.PARSE, 'Parse error.')); }
  if (Array.isArray(msg)) return send(res, 400, rpcError(null, ERR.INVALID, 'JSON-RPC batching is not supported in MCP 2025-06-18 or later.'));

  if (sid && !sessions.has(sid) && msg.method !== 'initialize') {
    return send(res, 404, rpcError(msg.id, ERR.INVALID, 'Unknown or expired session. Re-initialize.'));
  }

  const ctx = {};
  let out;
  try { out = dispatch(msg, ctx); } catch (err) {
    console.error('internal error:', err);
    out = rpcError(msg && msg.id, ERR.INTERNAL, 'Internal error.');
  }
  if (out === null) return send(res, 202); // notification or response: accepted, no body
  return send(res, 200, out, ctx.newSession ? { 'Mcp-Session-Id': ctx.newSession } : {});
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Pantry Pal MCP server (spec ${LATEST_VERSION}) listening on http://${HOST}:${PORT}/mcp`);
    if (AUTH_TOKEN) console.log('Bearer auth enabled.');
  });
}

module.exports = { server, dispatch, TOOLS };
