// Zero-dependency demo server (Node 18+). Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const PUBLIC = path.join(__dirname, 'public');

const norm = s => String(s || '').toUpperCase().replace(/\s+/g, '');
const FIELDS = ['vrn', 'pcn', 'date', 'time', 'make', 'colour', 'location', 'contravention', 'additional'];

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const seed = [{
      id: 1, vrn: 'AB12 CDE', pcn: 'DM00000001', date: '2026-06-17', time: '14:12',
      make: 'Example Make', colour: 'Grey', location: 'Sample Road',
      contravention: 'Being in a restricted lane (demo)',
      additional: 'This is sample evidence text for the demo.'
    }];
    fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
const save = rows => fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2));

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
function authed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return u === ADMIN_USER && p === ADMIN_PASS;
}
function clean(body) {
  const r = {};
  FIELDS.forEach(f => r[f] = String(body[f] || '').trim());
  return r;
}

// Call Stripe API using built-in https (no npm needed)
function stripeRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const options = {
      hostname: 'api.stripe.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // Public lookup
    if (p === '/api/lookup' && req.method === 'POST') {
      const { vrn, pcn } = await readBody(req);
      const rec = load().find(r => norm(r.vrn) === norm(vrn) && norm(r.pcn) === norm(pcn));
      return rec ? send(res, 200, rec) : send(res, 404, { error: 'No matching record found.' });
    }

    // Stripe: create payment intent
    if (p === '/api/create-payment-intent' && req.method === 'POST') {
      if (!STRIPE_SECRET_KEY) return send(res, 500, { error: 'Stripe not configured' });
      const { pcn, vrn } = await readBody(req);
      const intent = await stripeRequest('POST', '/v1/payment_intents', {
        amount: '100',        // £103.78 in pence
        currency: 'gbp',
        'metadata[pcn]': pcn || '',
        'metadata[vrn]': vrn || '',
        'automatic_payment_methods[enabled]': 'true'
      });
      if (intent.error) return send(res, 400, { error: intent.error.message });
      return send(res, 200, { clientSecret: intent.client_secret });
    }

    // Admin (password protected)
    if (p === '/admin.html' || p.startsWith('/api/admin')) {
      if (!authed(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Demo admin"' });
        return res.end('Authentication required');
      }
    }
    if (p === '/api/admin/records') {
      const rows = load();
      if (req.method === 'GET') return send(res, 200, rows);
      if (req.method === 'POST') {
        const r = clean(await readBody(req));
        if (!r.vrn || !r.pcn) return send(res, 400, { error: 'Reg number and PCN are required.' });
        r.id = Date.now();
        rows.push(r); save(rows);
        return send(res, 201, r);
      }
    }
    const m = p.match(/^\/api\/admin\/records\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      let rows = load();
      const i = rows.findIndex(r => r.id === id);
      if (i < 0) return send(res, 404, { error: 'Not found' });
      if (req.method === 'PUT') {
        rows[i] = { ...clean(await readBody(req)), id }; save(rows);
        return send(res, 200, rows[i]);
      }
      if (req.method === 'DELETE') { rows.splice(i, 1); save(rows); return send(res, 200, { ok: true }); }
    }

    // Static files
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory())
      return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.log(`Demo running: http://localhost:${PORT}  (admin: /admin.html)`));
