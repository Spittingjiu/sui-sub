import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'node:fs';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 8780;

const ADMIN_USER = process.env.SUI_SUB_USER || 'admin';
const ADMIN_PASS = process.env.SUI_SUB_PASS || 'admin123';
const SESSION_SECRET = process.env.SUI_SUB_SESSION_SECRET || 'sui-sub-secret-change-me';
const AUTO_SYNC_MS = Number(process.env.SUI_SUB_SYNC_MS || 5 * 60 * 1000);
const VIEW_CACHE_MS = Number(process.env.SUI_SUB_VIEW_CACHE_MS || 2000);
const E2EE_KEYS_FILE = path.join(__dirname, 'data', 'e2ee-keys.json');
const DEFAULT_CLASH_TEMPLATE_URL = process.env.SUI_SUB_CLASH_TEMPLATE_URL || 'https://raw.githubusercontent.com/Spittingjiu/clash-generic-template/main/clash-template.json';
const CLASH_TEMPLATE_CACHE_MS = Number(process.env.SUI_SUB_CLASH_TEMPLATE_CACHE_MS || 5 * 60 * 1000);


const IPINFO_TOKEN = process.env.SUI_SUB_IPINFO_TOKEN || '';
const GEOIP_CACHE = new Map();
const GEOIP_TTL_MS = 6 * 60 * 60 * 1000;


function ensureE2EEKeys(){
  try {
    if (!fs.existsSync(E2EE_KEYS_FILE)) {
      const kp = crypto.generateKeyPairSync('x25519');
      const privPem = kp.privateKey.export({type:'pkcs8',format:'pem'}).toString();
      const pubDer = kp.publicKey.export({type:'spki',format:'der'});
      fs.writeFileSync(E2EE_KEYS_FILE, JSON.stringify({ privateKeyPem: privPem, publicKeyB64: pubDer.toString('base64url') }, null, 2));
    }
    const k = JSON.parse(fs.readFileSync(E2EE_KEYS_FILE, 'utf8'));
    return {
      privateKey: crypto.createPrivateKey(k.privateKeyPem),
      publicKeyB64: String(k.publicKeyB64 || '')
    };
  } catch (e) {
    throw new Error('E2EE key init failed: ' + e.message);
  }
}

const E2EE = ensureE2EEKeys();
const NONCE_CACHE = new Map();
function seenNonce(nonce){
  const nowTs = Date.now();
  for (const [k,v] of NONCE_CACHE.entries()) if (v < nowTs) NONCE_CACHE.delete(k);
  if (NONCE_CACHE.has(nonce)) return true;
  NONCE_CACHE.set(nonce, nowTs + 10 * 60 * 1000);
  return false;
}

function decryptBridgePayload(body){
  if (!body?.e2ee) return body;
  const senderPub = crypto.createPublicKey({ key: Buffer.from(String(body.senderPub||''), 'base64url'), format:'der', type:'spki' });
  const secret = crypto.diffieHellman({ privateKey: E2EE.privateKey, publicKey: senderPub });
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = Buffer.from(String(body.iv||''), 'base64url');
  const tag = Buffer.from(String(body.tag||''), 'base64url');
  const ct = Buffer.from(String(body.ciphertext||''), 'base64url');
  const ts = Number(body.ts||0);
  const nonce = String(body.nonce||'');
  if (!nonce || !ts) throw new Error('bad e2ee envelope');
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) throw new Error('e2ee envelope expired');
  if (seenNonce(nonce)) throw new Error('replay detected');
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  const pt = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  return JSON.parse(pt);
}

const db = new Database(path.join(__dirname, 'data', 'sui-sub.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  panel_url TEXT NOT NULL,
  panel_token TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT,
  last_sync_status TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  node_hash TEXT NOT NULL,
  node_name TEXT,
  raw_link TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_id, node_hash),
  FOREIGN KEY(source_id) REFERENCES sources(id)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  node_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  template_url TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS subscription_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  subscription_id INTEGER,
  subscription_name TEXT,
  route_type TEXT NOT NULL,
  client_ip TEXT,
  user_agent TEXT,
  device_hint TEXT,
  created_at TEXT NOT NULL
);
`);

let sourceCols = db.prepare(`PRAGMA table_info(sources)`).all().map(x => x.name);
if (!sourceCols.includes('panel_token')) db.exec(`ALTER TABLE sources ADD COLUMN panel_token TEXT NOT NULL DEFAULT ''`);
if (!sourceCols.includes('last_sync_at')) db.exec(`ALTER TABLE sources ADD COLUMN last_sync_at TEXT`);
if (!sourceCols.includes('last_sync_status')) db.exec(`ALTER TABLE sources ADD COLUMN last_sync_status TEXT`);
if (!sourceCols.includes('source_type')) db.exec(`ALTER TABLE sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'sui_api'`);
db.prepare(`UPDATE sources SET source_type='sui_api' WHERE source_type IS NULL OR source_type=''`).run();
sourceCols = db.prepare(`PRAGMA table_info(sources)`).all().map(x => x.name);
const hasTokenUrlCol = sourceCols.includes('token_url');
const hasSourceTypeCol = sourceCols.includes('source_type');
const subCols = db.prepare(`PRAGMA table_info(subscriptions)`).all().map(x => x.name);
if (!subCols.includes('node_ids_json')) db.exec(`ALTER TABLE subscriptions ADD COLUMN node_ids_json TEXT NOT NULL DEFAULT '[]'`);

let adminCols = db.prepare(`PRAGMA table_info(admin_settings)`).all().map(x => x.name);
if (!adminCols.includes('template_url')) db.exec(`ALTER TABLE admin_settings ADD COLUMN template_url TEXT NOT NULL DEFAULT ''`);
adminCols = db.prepare(`PRAGMA table_info(admin_settings)`).all().map(x => x.name);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_logs_created_at ON subscription_logs(created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_logs_token ON subscription_logs(token)`);

const rowAdmin = db.prepare('SELECT * FROM admin_settings WHERE id=1').get();
if (!rowAdmin) {
  db.prepare('INSERT INTO admin_settings(id,username,password,template_url) VALUES(1,?,?,?)').run(ADMIN_USER, ADMIN_PASS, DEFAULT_CLASH_TEMPLATE_URL);
}
function getAdminSettings(){
  const row = db.prepare('SELECT username,password,template_url FROM admin_settings WHERE id=1').get();
  if (!row) return { username: ADMIN_USER, password: ADMIN_PASS, template_url: DEFAULT_CLASH_TEMPLATE_URL };
  return {
    username: row.username,
    password: row.password,
    template_url: String(row.template_url || DEFAULT_CLASH_TEMPLATE_URL)
  };
}
function setAdminSettings(username,password,template_url){
  db.prepare('UPDATE admin_settings SET username=?, password=?, template_url=? WHERE id=1').run(username,password,template_url);
}


function insertSourceRow(name, panel_url, panel_token, source_type = 'sui_api') {
  const syncStatus = source_type === 'local' ? 'local' : 'pending';
  if (hasTokenUrlCol && hasSourceTypeCol) {
    const ins = db.prepare('INSERT INTO sources(name,panel_url,token_url,source_type,panel_token,last_sync_at,last_sync_status,created_at) VALUES(?,?,?,?,?,?,?,?)');
    return ins.run(name, panel_url, '', source_type, panel_token, null, syncStatus, now());
  }
  if (hasTokenUrlCol) {
    const ins = db.prepare('INSERT INTO sources(name,panel_url,token_url,panel_token,last_sync_at,last_sync_status,created_at) VALUES(?,?,?,?,?,?,?)');
    return ins.run(name, panel_url, '', panel_token, null, syncStatus, now());
  }
  if (hasSourceTypeCol) {
    const ins = db.prepare('INSERT INTO sources(name,panel_url,panel_token,source_type,last_sync_at,last_sync_status,created_at) VALUES(?,?,?,?,?,?,?)');
    return ins.run(name, panel_url, panel_token, source_type, null, syncStatus, now());
  }
  const ins = db.prepare('INSERT INTO sources(name,panel_url,panel_token,last_sync_at,last_sync_status,created_at) VALUES(?,?,?,?,?,?)');
  return ins.run(name, panel_url, panel_token, null, syncStatus, now());
}

function ensureLocalSource() {
  const row = hasSourceTypeCol
    ? db.prepare("SELECT * FROM sources WHERE source_type='local' ORDER BY id ASC LIMIT 1").get()
    : db.prepare("SELECT * FROM sources WHERE panel_url='local://manual' ORDER BY id ASC LIMIT 1").get();
  if (row) return row;
  const r = insertSourceRow('本地节点', 'local://manual', '', 'local');
  return db.prepare('SELECT * FROM sources WHERE id=?').get(Number(r.lastInsertRowid));
}

app.use(express.json({ limit: '1mb' }));

const now = () => new Date().toISOString();

let viewCache = new Map();
function cacheGet(key){
  const v = viewCache.get(key);
  if (!v) return null;
  if (v.exp < Date.now()) { viewCache.delete(key); return null; }
  return v.data;
}
function cacheSet(key, data, ttl = VIEW_CACHE_MS){ viewCache.set(key, { data, exp: Date.now() + ttl }); }
function cacheInvalidate(){ viewCache.clear(); }


function signSession(user, exp) {
  const payload = Buffer.from(JSON.stringify({ user, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== good) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!obj?.user || !obj?.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const str = req.headers.cookie || '';
  const out = {};
  for (const p of str.split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}

function requireAuth(req, res, next) {
  if (req.path.startsWith('/api/auth/') || req.path.startsWith('/api/bridge/')) return next();
  if (req.path.startsWith('/sub/')) return next();
  const cookies = parseCookies(req);
  const sess = verifySession(cookies.sui_sub_session || '');
  if (!sess) return res.status(401).json({ ok: false, error: 'unauthorized' });
  req.user = sess.user;
  next();
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/sub/')) return requireAuth(req, res, next);
  next();
});

const b64decodeLoose = (str) => {
  const clean = (str || '').trim().replace(/\s+/g, '');
  const pad = clean.length % 4 === 0 ? '' : '='.repeat(4 - (clean.length % 4));
  try { return Buffer.from(clean + pad, 'base64').toString('utf8'); } catch { return ''; }
};

function parseSubscriptionText(text) {
  const t = (text || '').trim();
  if (!t) return [];
  let body = t;
  if (!/(vmess|vless|trojan|ss):\/\//i.test(t)) {
    const decoded = b64decodeLoose(t);
    if (/(vmess|vless|trojan|ss):\/\//i.test(decoded)) body = decoded;
  }
  const lines = body.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && /^(vmess|vless|trojan|ss):\/\//i.test(x));
  return lines.map((raw) => {
    let name = '';
    const hashIdx = raw.indexOf('#');
    if (hashIdx >= 0) name = decodeURIComponent(raw.slice(hashIdx + 1));
    if (!name && raw.startsWith('vmess://')) {
      const payload = b64decodeLoose(raw.slice('vmess://'.length));
      try { name = JSON.parse(payload).ps || ''; } catch {}
    }
    if (!name) name = raw.slice(0, 48);
    const node_hash = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw_link: raw, node_name: name, node_hash };
  });
}

function encodeB64NoPad(str='') {
  return Buffer.from(String(str), 'utf8').toString('base64').replace(/=+$/,'');
}

function withLinkName(rawLink, name) {
  const raw = String(rawLink || '').trim();
  const nm = String(name || '').trim();
  if (!raw || !nm) return raw;

  // vmess: 名称在 JSON.ps 中
  if (raw.startsWith('vmess://')) {
    try {
      const b64 = raw.slice('vmess://'.length);
      const payload = b64decodeLoose(b64);
      const j = JSON.parse(payload || '{}');
      j.ps = nm;
      return 'vmess://' + encodeB64NoPad(JSON.stringify(j));
    } catch {}
  }

  // vless/trojan/ss: 优先使用 URL hash
  try {
    const u = new URL(raw);
    u.hash = '#' + encodeURIComponent(nm);
    return u.toString();
  } catch {}

  // fallback: 直接替换/追加 #name
  const i = raw.indexOf('#');
  if (i >= 0) return raw.slice(0, i) + '#' + encodeURIComponent(nm);
  return raw + '#' + encodeURIComponent(nm);
}


async function suiRequest(source, apiPath, method = 'GET', body) {
  const base = String(source.panel_url || '').replace(/\/$/, '');
  const headers = { 'x-panel-token': source.panel_token, 'content-type': 'application/json' };
  const r = await fetch(`${base}${apiPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`${apiPath} HTTP ${r.status}`);
  return json;
}

async function fetchSuiPanelLinks(panelUrl, panelToken) {
  const base = String(panelUrl || '').replace(/\/$/, '');
  const headers = { 'x-panel-token': panelToken };

  const inbResp = await fetch(`${base}/api/inbounds`, { headers });
  if (!inbResp.ok) throw new Error(`/api/inbounds HTTP ${inbResp.status}`);
  const inbJson = await inbResp.json();
  if (!inbJson?.success || !Array.isArray(inbJson?.obj)) throw new Error('SUI 返回异常(inbounds)');

  const links = [];
  for (const ib of inbJson.obj) {
    if (!ib?.id) continue;
    const r = await fetch(`${base}/api/inbounds/${ib.id}/links`, { headers });
    if (!r.ok) continue;
    const j = await r.json();
    if (!j?.success || !Array.isArray(j?.obj)) continue;
    for (const one of j.obj) if (typeof one === 'string' && one.trim()) links.push(one.trim());
  }
  return parseSubscriptionText(links.join('\n'));
}

async function findSuiInboundIdByNodeHash(source, nodeHash) {
  const j = await suiRequest(source, '/api/inbounds');
  if (!j?.success || !Array.isArray(j?.obj)) return null;
  for (const ib of j.obj) {
    if (!ib?.id) continue;
    const lj = await suiRequest(source, `/api/inbounds/${ib.id}/links`);
    if (!lj?.success || !Array.isArray(lj?.obj)) continue;
    for (const one of lj.obj) {
      if (typeof one !== 'string' || !one.trim()) continue;
      const parsed = parseSubscriptionText(one.trim());
      if (!parsed.length) continue;
      if (parsed[0].node_hash === nodeHash) return Number(ib.id);
    }
  }
  return null;
}


function migrateLocalNodeDisplayNames() {
  if (!hasSourceTypeCol) return;
  const rows = db.prepare(`
    SELECT n.id, n.node_name, n.raw_link
    FROM nodes n
    LEFT JOIN sources s ON s.id=n.source_id
    WHERE COALESCE(s.source_type,'sui_api')='local'
  `).all();
  if (!rows.length) return;
  const tx = db.transaction((arr) => {
    for (const r of arr) {
      const nm = String(r.node_name || '').trim();
      if (!nm) continue;
      const normalizedRaw = withLinkName(r.raw_link, nm);
      const node_hash = crypto.createHash('sha256').update(normalizedRaw).digest('hex');
      db.prepare('UPDATE nodes SET raw_link=?, node_hash=?, updated_at=? WHERE id=?')
        .run(normalizedRaw, node_hash, now(), r.id);
    }
  });
  tx(rows);
}

function upsertNodes(sourceId, nodes) {
  let inserted = 0, updated = 0, removed = 0;
  const upsert = db.prepare(`
    INSERT INTO nodes(source_id,node_hash,node_name,raw_link,enabled,created_at,updated_at)
    VALUES(@source_id,@node_hash,@node_name,@raw_link,1,@created_at,@updated_at)
    ON CONFLICT(source_id,node_hash) DO UPDATE SET
      node_name=excluded.node_name,
      raw_link=excluded.raw_link,
      updated_at=excluded.updated_at
  `);
  const tx = db.transaction((arr) => {
    const latestHashes = new Set(arr.map(x => x.node_hash));
    for (const n of arr) {
      const before = db.prepare('SELECT id FROM nodes WHERE source_id=? AND node_hash=?').get(sourceId, n.node_hash);
      upsert.run({ source_id: sourceId, ...n, created_at: now(), updated_at: now() });
      if (before) updated++; else inserted++;
    }

    // prune: SUI 面板已删除的节点，同步后本地也删除
    const existing = db.prepare('SELECT id,node_hash FROM nodes WHERE source_id=?').all(sourceId);
    for (const e of existing) {
      if (!latestHashes.has(e.node_hash)) {
        db.prepare('DELETE FROM nodes WHERE id=?').run(e.id);
        removed++;
      }
    }

    // 订阅里清理失效 node_ids
    if (removed > 0) {
      const validNodeIds = new Set(db.prepare('SELECT id FROM nodes').all().map(x => x.id));
      const subs = db.prepare('SELECT id,node_ids_json FROM subscriptions').all();
      for (const s of subs) {
        const nodeIds = (JSON.parse(s.node_ids_json || '[]') || []).map(Number).filter(Boolean);
        const next = nodeIds.filter(id => validNodeIds.has(id));
        if (next.length !== nodeIds.length) {
          db.prepare('UPDATE subscriptions SET node_ids_json=? WHERE id=?').run(JSON.stringify(next), s.id);
        }
      }
    }
  });
  tx(nodes);
  const total = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE source_id=?').get(sourceId).c;
  return { inserted, updated, removed, fetched: nodes.length, total };
}

async function syncSource(id) {
  const source = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  if (!source) throw new Error('source not found');
  if (String(source.source_type || 'sui_api') === 'local') return { local: true };
  if (!source.panel_token) throw new Error('panel token empty');
  const nodes = await fetchSuiPanelLinks(source.panel_url, source.panel_token);
  const st = upsertNodes(id, nodes);
  db.prepare('UPDATE sources SET last_sync_at=?, last_sync_status=? WHERE id=?').run(now(), 'ok', id);
  return st;
}

let syncing = false;
async function autoSyncAll() {
  if (syncing) return;
  syncing = true;
  try {
    const sources = db.prepare("SELECT id FROM sources WHERE COALESCE(source_type,'sui_api')!='local' ORDER BY id ASC").all();
    for (const s of sources) {
      try {
        await syncSource(s.id);
      } catch (e) {
        db.prepare('UPDATE sources SET last_sync_at=?, last_sync_status=? WHERE id=?').run(now(), `error: ${String(e.message || e).slice(0, 160)}`, s.id);
      }
    }
  } finally {
    syncing = false;
  }
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const adm = getAdminSettings();
  if (String(username) !== adm.username || String(password) !== adm.password) {
    return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const token = signSession(username, exp);
  res.setHeader('Set-Cookie', `sui_sub_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
  res.json({ ok: true, username });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sui_sub_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req);
  const sess = verifySession(cookies.sui_sub_session || '');
  if (!sess) return res.status(401).json({ ok: false });
  res.json({ ok: true, username: sess.user });
});


app.get('/api/admin/user', (_req, res) => {
  const adm = getAdminSettings();
  res.json({ ok: true, username: adm.username, template_url: adm.template_url || DEFAULT_CLASH_TEMPLATE_URL });
});

app.post('/api/admin/user', (req, res) => {
  try {
    const current = getAdminSettings();
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const template_url = String(req.body?.template_url || '').trim() || DEFAULT_CLASH_TEMPLATE_URL;

    if (!username) return res.status(400).json({ ok: false, error: 'username 必填' });
    if (password && password.length < 6) return res.status(400).json({ ok: false, error: 'password 至少6位' });
    if (!/^https?:\/\//i.test(template_url)) return res.status(400).json({ ok: false, error: 'template_url 必须是 http/https 链接' });

    const nextPassword = password || current.password;
    setAdminSettings(username, nextPassword, template_url);
    cacheInvalidate();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/subscription-logs', (req, res) => {
  try {
    const limit = Math.max(1, Math.min(10, Number(req.query.limit || 10)));
    const rows = db.prepare(`
      SELECT id, token, subscription_id, subscription_name, route_type, client_ip, user_agent, device_hint, created_at
      FROM subscription_logs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
    res.json({ ok: true, logs: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/bridge/e2ee-meta', (_req, res) => {
  res.json({ ok: true, alg: 'x25519+aes-256-gcm', publicKey: E2EE.publicKeyB64 });
});

// bridge: 供 SUI 面板一键写入 source（按用户名匹配）
app.post('/api/bridge/push-source', async (req, res) => {
  try {
    if (!req.body?.e2ee) return res.status(400).json({ ok: false, error: 'e2ee required' });
    const payload = decryptBridgePayload(req.body || {});
    const username = String(payload?.username || '').trim();
    const password = String(payload?.password || '');
    const name = String(payload?.name || 'sui-auto').trim();
    const panel_url = String(payload?.panel_url || '').trim();
    const panel_token = String(payload?.panel_token || '').trim();
    if (!username || !password || !panel_url || !panel_token) return res.status(400).json({ ok: false, error: 'username/password/panel_url/panel_token 必填' });
    const adm = getAdminSettings();
    if (username !== adm.username || password !== adm.password) return res.status(403).json({ ok: false, error: 'sub 账号或密码不匹配' });

    const old = db.prepare('SELECT * FROM sources WHERE panel_url=?').get(panel_url);
    let source_id;
    if (old) {
      source_id = old.id;
      db.prepare('UPDATE sources SET name=?, panel_token=? WHERE id=?').run(name, panel_token, source_id);
    } else {
      const r = insertSourceRow(name, panel_url, panel_token);
      source_id = Number(r.lastInsertRowid);
    }
    syncSource(source_id).catch(()=>{});
    cacheInvalidate();
    res.json({ ok: true, source_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sources', (req, res) => {
  ensureLocalSource();
  const sources = db.prepare('SELECT * FROM sources ORDER BY id DESC').all();
  res.json({ ok: true, sources });
});

app.post('/api/sources', async (req, res) => {
  try {
    const { name, panel_url, panel_token } = req.body || {};
    if (!name || !panel_url || !panel_token) return res.status(400).json({ ok: false, error: 'name / panel_url / panel_token 必填' });

    const result = insertSourceRow(name.trim(), panel_url.trim(), panel_token.trim());
    const source_id = Number(result.lastInsertRowid);

    // 立即同步一次（异步）
    syncSource(source_id).then(()=>cacheInvalidate()).catch((e) => {
      db.prepare('UPDATE sources SET last_sync_at=?, last_sync_status=? WHERE id=?').run(now(), `error: ${String(e.message || e).slice(0, 160)}`, source_id);
    });

    cacheInvalidate();
    res.json({ ok: true, source_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/sources/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const old = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
    if (!old) return res.status(404).json({ ok: false, error: 'source not found' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name 必填' });
    db.prepare('UPDATE sources SET name=? WHERE id=?').run(name, id);
    cacheInvalidate();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/sources/:id', (req, res) => {
  const id = Number(req.params.id);
  const src = db.prepare('SELECT * FROM sources WHERE id=?').get(id);
  if (src && String(src.source_type || 'sui_api') === 'local') return res.status(400).json({ ok:false, error:'本地节点源不可删除' });
  const deletedNodeIds = db.prepare('SELECT id FROM nodes WHERE source_id=?').all(id).map(x=>x.id);
  db.prepare('DELETE FROM nodes WHERE source_id=?').run(id);
  db.prepare('DELETE FROM sources WHERE id=?').run(id);
  // 清理订阅里失效的 source/node 选择
  const deletedSet = new Set(deletedNodeIds);
  const subs = db.prepare('SELECT id,source_ids_json,node_ids_json FROM subscriptions').all();
  for (const s of subs) {
    const sourceIds = (JSON.parse(s.source_ids_json || '[]') || []).map(Number).filter(Boolean).filter(x => x !== id);
    const nodeIds = (JSON.parse(s.node_ids_json || '[]') || []).map(Number).filter(Boolean).filter(nid => !deletedSet.has(nid));
    if (!sourceIds.length && !nodeIds.length) db.prepare('DELETE FROM subscriptions WHERE id=?').run(s.id);
    else db.prepare('UPDATE subscriptions SET source_ids_json=?, node_ids_json=? WHERE id=?').run(JSON.stringify(sourceIds), JSON.stringify(nodeIds), s.id);
  }
  cacheInvalidate();
  res.json({ ok: true });
});

app.post('/api/sources/sync-all', async (_req, res) => {
  await autoSyncAll();
  cacheInvalidate();
  res.json({ ok: true });
});


// backend-view endpoints: keep business aggregation on server side
app.get('/api/view/home', (_req, res) => {
  const key = 'view-home';
  const hit = cacheGet(key);
  if (hit) return res.json({ ok: true, sources: hit, cached: true });

  const rows = db.prepare(`
    SELECT s.*, COALESCE(COUNT(n.id),0) AS node_count
    FROM sources s
    LEFT JOIN nodes n ON n.source_id=s.id
    GROUP BY s.id
    ORDER BY s.id DESC
  `).all();
  cacheSet(key, rows);
  res.json({ ok: true, sources: rows, cached: false });
});

app.get('/api/view/nodes', (req, res) => {
  const sourceId = Number(req.query.sourceId || 0);
  const key = `view-nodes:${sourceId}`;
  const hit = cacheGet(key);
  if (hit) return res.json({ ok: true, nodes: hit, cached: true });
  let rows;
  if (sourceId > 0) {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name, s.source_type as source_type
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE n.source_id=?
      ORDER BY n.id DESC
    `).all(sourceId);
  } else {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name, s.source_type as source_type
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      ORDER BY n.id DESC
    `).all();
  }
  cacheSet(key, rows);
  res.json({ ok: true, nodes: rows, cached: false });
});


app.get('/api/view/bootstrap', (req, res) => {
  ensureLocalSource();
  const key = 'bootstrap';
  const hit = cacheGet(key);
  if (hit) return res.json({ ok: true, ...hit, cached: true });

  const sources = db.prepare(`
    SELECT s.*, COALESCE(COUNT(n.id),0) AS node_count
    FROM sources s
    LEFT JOIN nodes n ON n.source_id=s.id
    GROUP BY s.id
    ORDER BY s.id DESC
  `).all();

  const nodes = db.prepare(`
    SELECT n.*, s.name as source_name
    FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
    ORDER BY n.id DESC
  `).all();

  const subs = db.prepare('SELECT * FROM subscriptions ORDER BY id DESC').all();
  const sourceMap = new Map(sources.map(x => [x.id, x.name]));
  const subscriptions = subs.map(s => {
    const sourceIds = (JSON.parse(s.source_ids_json || '[]') || []).map(Number).filter(Boolean);
    const nodeIds = (JSON.parse(s.node_ids_json || '[]') || []).map(Number).filter(Boolean);
    const urlPath = `/sub/${s.token}`;
    return {
      id: s.id,
      name: s.name,
      source_ids: sourceIds,
      source_names: sourceIds.map(i => sourceMap.get(i)).filter(Boolean),
      node_ids: nodeIds,
      url: urlPath,
      full_url: `${req.protocol}://${req.get('host')}${urlPath}`
    };
  });

  const payload = { sources, nodes, subscriptions };
  cacheSet(key, payload);
  res.json({ ok: true, ...payload, cached: false });
});

app.get('/api/view/modal-nodes', (req, res) => {
  const sourceId = Number(req.query.sourceId || 0);
  const key = `modal-nodes:${sourceId}`;
  const hit = cacheGet(key);
  if (hit) return res.json({ ok: true, nodes: hit, cached: true });
  let rows;
  if (sourceId > 0) {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name, s.source_type as source_type
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE n.source_id=?
      ORDER BY n.id DESC
    `).all(sourceId);
  } else {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name, s.source_type as source_type
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      ORDER BY n.id DESC
    `).all();
  }
  cacheSet(key, rows);
  res.json({ ok: true, nodes: rows, cached: false });
});

app.get('/api/view/subscriptions', (req, res) => {
  const key = 'view-subscriptions';
  const hit = cacheGet(key);
  if (hit) return res.json({ ok: true, subscriptions: hit, cached: true });

  const subs = db.prepare('SELECT * FROM subscriptions ORDER BY id DESC').all();
  const sourceMap = new Map(db.prepare('SELECT id,name FROM sources').all().map(x => [x.id, x.name]));
  const out = subs.map(s => {
    const sourceIds = (JSON.parse(s.source_ids_json || '[]') || []).map(Number).filter(Boolean);
    const nodeIds = (JSON.parse(s.node_ids_json || '[]') || []).map(Number).filter(Boolean);
    const urlPath = `/sub/${s.token}`;
    return {
      id: s.id,
      name: s.name,
      source_ids: sourceIds,
      source_names: sourceIds.map(i => sourceMap.get(i)).filter(Boolean),
      node_ids: nodeIds,
      url: urlPath,
      full_url: `${req.protocol}://${req.get('host')}${urlPath}`
    };
  });
  cacheSet(key, out);
  res.json({ ok: true, subscriptions: out, cached: false });
});


app.get('/api/sui/:sourceId/inbounds', async (req, res) => {
  try {
    const sourceId = Number(req.params.sourceId);
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
    if (!source) return res.status(404).json({ ok: false, error: 'source not found' });
    if (String(source.source_type || 'sui_api') === 'local') return res.status(400).json({ ok: false, error: 'local source does not support SUI inbounds' });
    const j = await suiRequest(source, '/api/inbounds');
    if (!j?.success || !Array.isArray(j?.obj)) return res.status(500).json({ ok: false, error: 'sui response invalid' });
    res.json({ ok: true, inbounds: j.obj });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/sui/:sourceId/reality-quick', async (req, res) => {
  try {
    const sourceId = Number(req.params.sourceId);
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
    if (!source) return res.status(404).json({ ok: false, error: 'source not found' });
    const remark = String(req.body?.remark || `quick-${Date.now()}`).trim();
    const j = await suiRequest(source, '/api/inbounds/add-reality-quick', 'POST', { remark });
    if (!j?.success) return res.status(500).json({ ok: false, error: j?.msg || 'create failed' });
    await syncSource(sourceId).catch(()=>{});
    cacheInvalidate();
    res.json({ ok: true, obj: j.obj || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/sui/:sourceId/inbounds/:inboundId', async (req, res) => {
  try {
    const sourceId = Number(req.params.sourceId);
    const inboundId = Number(req.params.inboundId);
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
    if (!source) return res.status(404).json({ ok: false, error: 'source not found' });
    const j = await suiRequest(source, `/api/inbounds/${inboundId}`, 'DELETE');
    if (!j?.success) return res.status(500).json({ ok: false, error: j?.msg || 'delete failed' });
    await syncSource(sourceId).catch(()=>{});
    cacheInvalidate();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/nodes', (req, res) => {
  const sourceIds = String(req.query.sourceIds || '').split(',').map(x => Number(x)).filter(Boolean);
  let rows;
  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    rows = db.prepare(`
      SELECT n.*, s.name as source_name
      FROM nodes n
      LEFT JOIN sources s ON s.id=n.source_id
      WHERE n.source_id IN (${placeholders})
      ORDER BY n.id DESC
    `).all(...sourceIds);
  } else {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name
      FROM nodes n
      LEFT JOIN sources s ON s.id=n.source_id
      ORDER BY n.id DESC
    `).all();
  }
  res.json({ ok: true, nodes: rows });
});

app.post('/api/nodes/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
  if (!row) return res.status(404).json({ ok: false, error: 'node not found' });
  const next = row.enabled ? 0 : 1;
  db.prepare('UPDATE nodes SET enabled=?, updated_at=? WHERE id=?').run(next, now(), id);
  cacheInvalidate();
  res.json({ ok: true, enabled: next });
});

app.post('/api/local-nodes', (req, res) => {
  try {
    const source = ensureLocalSource();
    const raw = String(req.body?.raw_link || '').trim();
    const customName = String(req.body?.node_name || '').trim();
    if (!raw) return res.status(400).json({ ok:false, error:'raw_link 必填' });
    const parsed = parseSubscriptionText(raw);
    if (!parsed.length) return res.status(400).json({ ok:false, error:'无效节点链接' });
    const one = parsed[0];
    const node_name = customName || one.node_name || 'local-node';
    const normalizedRaw = withLinkName(one.raw_link, node_name);
    const node_hash = crypto.createHash('sha256').update(normalizedRaw).digest('hex');

    // 先按内容hash查重，再按名字+源兜底避免重复
    let exists = db.prepare('SELECT id FROM nodes WHERE source_id=? AND node_hash=?').get(source.id, node_hash);
    if (!exists && customName) {
      exists = db.prepare('SELECT id FROM nodes WHERE source_id=? AND node_name=?').get(source.id, node_name);
    }

    if (exists) {
      db.prepare('UPDATE nodes SET node_name=?, raw_link=?, node_hash=?, enabled=1, updated_at=? WHERE id=?')
        .run(node_name, normalizedRaw, node_hash, now(), exists.id);
      cacheInvalidate();
      return res.json({ ok:true, id: exists.id, updated: true });
    }

    const r = db.prepare('INSERT INTO nodes(source_id,node_hash,node_name,raw_link,enabled,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
      .run(source.id, node_hash, node_name, normalizedRaw, now(), now());
    cacheInvalidate();
    return res.json({ ok:true, id: Number(r.lastInsertRowid), created: true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
});

app.put('/api/nodes/:id/rename', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const node = db.prepare('SELECT n.*, s.source_type, s.id as source_id, s.panel_url, s.panel_token FROM nodes n LEFT JOIN sources s ON s.id=n.source_id WHERE n.id=?').get(id);
    if (!node) return res.status(404).json({ ok:false, error:'node not found' });
    const node_name = String(req.body?.node_name || '').trim();
    if (!node_name) return res.status(400).json({ ok:false, error:'node_name 必填' });

    if (String(node.source_type || 'sui_api') === 'local') {
      db.prepare('UPDATE nodes SET node_name=?, updated_at=? WHERE id=?').run(node_name, now(), id);
      cacheInvalidate();
      return res.json({ ok:true, synced:'local-only-name' });
    }

    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(node.source_id);
    if (!source) return res.status(404).json({ ok:false, error:'source not found' });
    const inboundId = await findSuiInboundIdByNodeHash(source, node.node_hash);
    if (!inboundId) return res.status(404).json({ ok:false, error:'sui inbound not found by hash' });

    await suiRequest(source, `/api/inbounds/${inboundId}`, 'PUT', { remark: node_name });
    await syncSource(source.id);
    cacheInvalidate();
    return res.json({ ok:true, synced:'sui+local', inbound_id: inboundId });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
});

app.delete('/api/local-nodes/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare("SELECT n.id,s.source_type FROM nodes n LEFT JOIN sources s ON s.id=n.source_id WHERE n.id=?").get(id);
    if (!row) return res.status(404).json({ ok:false, error:'node not found' });
    if (String(row.source_type || 'sui_api') !== 'local') return res.status(400).json({ ok:false, error:'仅可删除本地节点' });
    db.prepare('DELETE FROM nodes WHERE id=?').run(id);
    const subs = db.prepare('SELECT id,node_ids_json FROM subscriptions').all();
    for (const s of subs) {
      const nodeIds = (JSON.parse(s.node_ids_json || '[]') || []).map(Number).filter(Boolean);
      const next = nodeIds.filter(nid => nid !== id);
      if (next.length !== nodeIds.length) {
        db.prepare('UPDATE subscriptions SET node_ids_json=? WHERE id=?').run(JSON.stringify(next), s.id);
      }
    }
    cacheInvalidate();
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
});

app.get('/api/subscriptions', (req, res) => {
  const subs = db.prepare('SELECT * FROM subscriptions ORDER BY id DESC').all();
  const sourceMap = new Map(db.prepare('SELECT id,name FROM sources').all().map(x => [x.id, x.name]));
  const nodeMap = new Map(db.prepare('SELECT id,node_name,source_id FROM nodes').all().map(x => [x.id, x]));
  const out = subs.map(s => {
    const sourceIds = (JSON.parse(s.source_ids_json || '[]') || []).map(Number).filter(Boolean);
    const nodeIds = (JSON.parse(s.node_ids_json || '[]') || []).map(Number).filter(Boolean);
    return {
      id: s.id,
      name: s.name,
      token: s.token,
      source_ids: sourceIds,
      source_names: sourceIds.map(i => sourceMap.get(i)).filter(Boolean),
      node_ids: nodeIds,
      node_names: nodeIds.map(i => nodeMap.get(i)?.node_name || `#${i}`).filter(Boolean),
      url: `/sub/${s.token}`,
      created_at: s.created_at
    };
  });
  res.json({ ok: true, subscriptions: out });
});

app.post('/api/subscriptions', (req, res) => {
  try {
    const { name, source_ids, node_ids } = req.body || {};
    const sids = Array.isArray(source_ids) ? source_ids.map(Number).filter(Boolean) : [];
    const nids = Array.isArray(node_ids) ? node_ids.map(Number).filter(Boolean) : [];
    if (!name) return res.status(400).json({ ok: false, error: 'name 必填' });
    if (!sids.length && !nids.length) return res.status(400).json({ ok: false, error: '至少选择 source 或 node' });
    const token = crypto.randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO subscriptions(name,token,source_ids_json,node_ids_json,created_at) VALUES(?,?,?,?,?)')
      .run(String(name).trim(), token, JSON.stringify(sids), JSON.stringify(nids), now());
    cacheInvalidate();
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.put('/api/subscriptions/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const old = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id);
    if (!old) return res.status(404).json({ ok: false, error: 'not found' });
    const name = String(req.body?.name || old.name).trim() || old.name;
    const sids = Array.isArray(req.body?.source_ids) ? req.body.source_ids.map(Number).filter(Boolean) : (JSON.parse(old.source_ids_json || '[]') || []);
    const nids = Array.isArray(req.body?.node_ids) ? req.body.node_ids.map(Number).filter(Boolean) : (JSON.parse(old.node_ids_json || '[]') || []);
    if (!sids.length && !nids.length) return res.status(400).json({ ok: false, error: '至少选择 source 或 node' });
    db.prepare('UPDATE subscriptions SET name=?, source_ids_json=?, node_ids_json=? WHERE id=?').run(name, JSON.stringify(sids), JSON.stringify(nids), id);
    cacheInvalidate();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM subscriptions WHERE id=?').run(id);
  cacheInvalidate();
  res.json({ ok: true });
});

function decodeHashName(raw = '') {
  const i = String(raw).indexOf('#');
  if (i < 0) return '';
  try { return decodeURIComponent(String(raw).slice(i + 1)).trim(); } catch { return String(raw).slice(i + 1).trim(); }
}

function b64decodeUrlSafe(s = '') {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/').trim();
  return b64decodeLoose(t);
}


function normalizeNodeName(name = '') {
  let n = String(name || '').trim();
  const map = {
    '寰峰浗浼樺寲': '德国优化',
    '鏂板姞鍧': '新加坡'
  };
  if (map[n]) n = map[n];
  return n || 'node';
}


async function getCountryByIp(ip) {
  const v4 = String(ip || '').trim();
  if (!v4 || /[^0-9.]/.test(v4)) return null;
  const nowTs = Date.now();
  const hit = GEOIP_CACHE.get(v4);
  if (hit && hit.exp > nowTs) return hit.country;
  let country = null;
  try {
    if (IPINFO_TOKEN) {
      const r = await fetch(`https://ipinfo.io/${v4}/json?token=${IPINFO_TOKEN}`, { timeout: 5000 });
      if (r.ok) {
        const j = await r.json();
        country = String(j.country || '').toUpperCase() || null;
      }
    }
  } catch {}
  try {
    if (!country) {
      const r = await fetch(`http://ip-api.com/json/${v4}?fields=countryCode,status`, { timeout: 5000 });
      if (r.ok) {
        const j = await r.json();
        const t = String(j.countryCode || '').trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(t)) country = t;
      }
    }
  } catch {}
  GEOIP_CACHE.set(v4, { country, exp: nowTs + GEOIP_TTL_MS });
  return country;
}

async function pickUsNodesByIp(proxies = []) {
  const out = [];
  for (const p of proxies) {
    const ip = String(p.server || '');
    const c = await getCountryByIp(ip);
    if (c === 'US') out.push(p.name);
  }
  return out;
}

function uniqNameFactory() {
  const seen = new Map();
  return (name) => {
    const base = normalizeNodeName(name || 'node');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}

function parseLinkToClashProxy(raw, uniqueName) {
  const link = String(raw || '').trim();
  if (!link) return null;

  if (link.startsWith('vmess://')) {
    const payload = b64decodeUrlSafe(link.slice('vmess://'.length));
    let j = {};
    try { j = JSON.parse(payload || '{}'); } catch { return null; }
    const name = uniqueName(j.ps || decodeHashName(link) || `vmess-${j.add || 'node'}`);
    const network = j.net || 'tcp';
    const p = {
      name,
      type: 'vmess',
      server: j.add,
      port: Number(j.port || 0),
      uuid: j.id,
      alterId: Number(j.aid || 0),
      cipher: j.scy || 'auto',
      udp: true,
      network
    };
    if (!p.server || !p.port || !p.uuid) return null;
    const tlsOn = String(j.tls || '').toLowerCase() === 'tls';
    if (tlsOn) p.tls = true;
    if (j.sni) p.servername = j.sni;
    if (network === 'ws') {
      p['ws-opts'] = { path: j.path || '/', headers: { Host: j.host || j.add || '' } };
    }
    return p;
  }

  if (link.startsWith('vless://')) {
    let u;
    try { u = new URL(link); } catch { return null; }
    const name = uniqueName(decodeHashName(link) || `vless-${u.hostname}`);
    const security = (u.searchParams.get('security') || 'none').toLowerCase();
    const network = (u.searchParams.get('type') || 'tcp').toLowerCase();
    const p = {
      name,
      type: 'vless',
      server: u.hostname,
      port: Number(u.port || 0),
      uuid: decodeURIComponent(u.username || ''),
      udp: true,
      network
    };
    if (!p.server || !p.port || !p.uuid) return null;
    const flow = u.searchParams.get('flow');
    if (flow) p.flow = flow;
    const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
    if (security !== 'none') p.tls = true;
    if (sni) p.servername = sni;
    if (network === 'ws') {
      p['ws-opts'] = {
        path: u.searchParams.get('path') || '/',
        headers: { Host: u.searchParams.get('host') || sni || u.hostname }
      };
    }
    if (security === 'reality') {
      const pbk = u.searchParams.get('pbk') || '';
      const sid = u.searchParams.get('sid') || '';
      const spx = u.searchParams.get('spx') || u.searchParams.get('spiderx') || u.searchParams.get('spiderX') || '/';
      const fp = u.searchParams.get('fp') || 'chrome';
      if (pbk) p['reality-opts'] = { 'public-key': pbk, 'short-id': sid, 'spider-x': spx };
      p['client-fingerprint'] = fp;
    }
    return p;
  }

  if (link.startsWith('trojan://')) {
    let u;
    try { u = new URL(link); } catch { return null; }
    const name = uniqueName(decodeHashName(link) || `trojan-${u.hostname}`);
    const network = (u.searchParams.get('type') || 'tcp').toLowerCase();
    const security = (u.searchParams.get('security') || 'tls').toLowerCase();
    const p = {
      name,
      type: 'trojan',
      server: u.hostname,
      port: Number(u.port || 0),
      password: decodeURIComponent(u.username || ''),
      udp: true,
      network
    };
    if (!p.server || !p.port || !p.password) return null;
    if (security !== 'none') p.tls = true;
    const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
    if (sni) p.sni = sni;
    if (network === 'ws') {
      p['ws-opts'] = {
        path: u.searchParams.get('path') || '/',
        headers: { Host: u.searchParams.get('host') || sni || u.hostname }
      };
    }
    return p;
  }

  if (link.startsWith('ss://')) {
    let u;
    try { u = new URL(link); } catch { return null; }
    const name = uniqueName(decodeHashName(link) || `ss-${u.hostname}`);
    let method = '', password = '';
    if (u.password) {
      method = decodeURIComponent(u.username || '');
      password = decodeURIComponent(u.password || '');
    } else {
      const decoded = b64decodeUrlSafe(decodeURIComponent(u.username || ''));
      const i = decoded.indexOf(':');
      if (i > 0) {
        method = decoded.slice(0, i);
        password = decoded.slice(i + 1);
      }
    }
    const p = {
      name,
      type: 'ss',
      server: u.hostname,
      port: Number(u.port || 0),
      cipher: method,
      password,
      udp: true
    };
    if (!p.server || !p.port || !p.cipher || !p.password) return null;
    return p;
  }

  return null;
}


function parseLinkToSingboxOutbound(raw, uniqueName) {
  const link = String(raw || '').trim();
  if (!link) return null;

  if (link.startsWith('vmess://')) {
    const payload = b64decodeUrlSafe(link.slice('vmess://'.length));
    let j = {};
    try { j = JSON.parse(payload || '{}'); } catch { return null; }
    const tag = uniqueName(j.ps || decodeHashName(link) || `vmess-${j.add || 'node'}`);
    const network = j.net || 'tcp';
    const o = {
      tag,
      type: 'vmess',
      server: j.add,
      server_port: Number(j.port || 0),
      uuid: j.id,
      security: j.scy || 'auto'
    };
    if (!o.server || !o.server_port || !o.uuid) return null;
    if (String(j.tls || '').toLowerCase() === 'tls') {
      o.tls = { enabled: true, server_name: j.sni || undefined };
    }
    if (network === 'ws') {
      o.transport = {
        type: 'ws',
        path: j.path || '/',
        headers: { Host: j.host || j.add || '' }
      };
    }
    return o;
  }

  if (link.startsWith('vless://')) {
    let u; try { u = new URL(link); } catch { return null; }
    const tag = uniqueName(decodeHashName(link) || `vless-${u.hostname}`);
    const security = (u.searchParams.get('security') || 'none').toLowerCase();
    const network = (u.searchParams.get('type') || 'tcp').toLowerCase();
    const o = {
      tag,
      type: 'vless',
      server: u.hostname,
      server_port: Number(u.port || 0),
      uuid: decodeURIComponent(u.username || '')
    };
    if (!o.server || !o.server_port || !o.uuid) return null;
    const flow = u.searchParams.get('flow');
    if (flow) o.flow = flow;
    const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
    if (security !== 'none') o.tls = { enabled: true, server_name: sni || undefined };
    if (network === 'ws') {
      o.transport = {
        type: 'ws',
        path: u.searchParams.get('path') || '/',
        headers: { Host: u.searchParams.get('host') || sni || u.hostname }
      };
    }
    return o;
  }

  if (link.startsWith('trojan://')) {
    let u; try { u = new URL(link); } catch { return null; }
    const tag = uniqueName(decodeHashName(link) || `trojan-${u.hostname}`);
    const network = (u.searchParams.get('type') || 'tcp').toLowerCase();
    const o = {
      tag,
      type: 'trojan',
      server: u.hostname,
      server_port: Number(u.port || 0),
      password: decodeURIComponent(u.username || '')
    };
    if (!o.server || !o.server_port || !o.password) return null;
    const sni = u.searchParams.get('sni') || u.searchParams.get('host') || '';
    o.tls = { enabled: true, server_name: sni || undefined };
    if (network === 'ws') {
      o.transport = {
        type: 'ws',
        path: u.searchParams.get('path') || '/',
        headers: { Host: u.searchParams.get('host') || sni || u.hostname }
      };
    }
    return o;
  }

  if (link.startsWith('ss://')) {
    let u; try { u = new URL(link); } catch { return null; }
    const tag = uniqueName(decodeHashName(link) || `ss-${u.hostname}`);
    let method = '', password = '';
    if (u.password) {
      method = decodeURIComponent(u.username || '');
      password = decodeURIComponent(u.password || '');
    } else {
      const decoded = b64decodeUrlSafe(decodeURIComponent(u.username || ''));
      const i = decoded.indexOf(':');
      if (i > 0) {
        method = decoded.slice(0, i);
        password = decoded.slice(i + 1);
      }
    }
    const o = {
      tag,
      type: 'shadowsocks',
      server: u.hostname,
      server_port: Number(u.port || 0),
      method,
      password
    };
    if (!o.server || !o.server_port || !o.method || !o.password) return null;
    return o;
  }

  return null;
}

async function buildSingboxConfigByLinks(links = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const resp = await fetch('https://raw.githubusercontent.com/Spittingjiu/sui-sub/main/experimental/singbox/singbox-template.json', { signal: controller.signal });
  clearTimeout(timer);
  if (!resp.ok) throw new Error(`singbox template fetch failed: ${resp.status}`);
  const template = JSON.parse(await resp.text());

  const uniq = uniqNameFactory();
  const nodes = [];
  for (const raw of links) {
    const o = parseLinkToSingboxOutbound(raw, uniq);
    if (o) nodes.push(o);
  }

  const existing = Array.isArray(template.outbounds) ? template.outbounds : [];
  const staticOutbounds = existing.filter(x => !['vmess','vless','trojan','shadowsocks'].includes(String(x?.type || '').toLowerCase()));
  const nodeTags = nodes.map(n => n.tag);

  const outbounds = [...staticOutbounds, ...nodes];

  for (const ob of outbounds) {
    const t = String(ob?.type || '');
    if (t === 'selector' || t === 'urltest') {
      const arr = Array.isArray(ob.outbounds) ? ob.outbounds : [];
      const merged = [...new Set([...arr, ...nodeTags])];
      ob.outbounds = merged.filter(x => !/^(DIRECT|REJECT|PASS)$/i.test(String(x)));
      if (t === 'selector' && (!ob.default || !ob.outbounds.includes(ob.default))) {
        ob.default = ob.outbounds[0] || 'direct';
      }
    }
  }

  return { ...template, outbounds };
}

function stringifyYamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (/^geosite:/i.test(s)) return JSON.stringify(s);
  if (/^[a-zA-Z0-9_.:@\/-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function toYaml(v, indent = 0) {
  const sp = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map(item => {
      if (item && typeof item === 'object') {
        return `${sp}-\n${toYaml(item, indent + 2)}`;
      }
      return `${sp}- ${stringifyYamlScalar(item)}`;
    }).join('\n');
  }
  if (v && typeof v === 'object') {
    const lines = [];
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (val && typeof val === 'object') {
        if (Array.isArray(val) && val.length === 0) {
          lines.push(`${sp}${k}: []`);
        } else {
          lines.push(`${sp}${k}:`);
          lines.push(toYaml(val, indent + 2));
        }
      } else {
        lines.push(`${sp}${k}: ${stringifyYamlScalar(val)}`);
      }
    }
    return lines.join('\n');
  }
  return `${sp}${stringifyYamlScalar(v)}`;
}

function isPlainObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let clashTemplateCache = { at: 0, data: null, url: '' };

async function loadRemoteClashTemplate({ forceRefresh = false } = {}) {
  const nowTs = Date.now();
  const templateUrl = String(getAdminSettings().template_url || DEFAULT_CLASH_TEMPLATE_URL);
  const sameUrl = clashTemplateCache.url === templateUrl;
  const canUseCache = sameUrl && clashTemplateCache.data && (nowTs - clashTemplateCache.at) < CLASH_TEMPLATE_CACHE_MS;

  if (!forceRefresh && canUseCache) return clashTemplateCache.data;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const url = forceRefresh
      ? `${templateUrl}${templateUrl.includes('?') ? '&' : '?'}_ts=${Date.now()}`
      : templateUrl;
    const resp = await fetch(url, {
      headers: {
        'accept': 'application/json,text/plain,*/*',
        'cache-control': 'no-cache'
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const text = await resp.text();
    const obj = JSON.parse(text);
    if (!isPlainObject(obj)) throw new Error('template is not object');

    clashTemplateCache = { at: nowTs, data: obj, url: templateUrl };
    return obj;
  } catch (e) {
    console.warn('[clash-template] refresh failed, fallback cache/built-in:', e?.message || e);
    if (clashTemplateCache.data) return clashTemplateCache.data;
    return null;
  }
}

async function buildClashConfigByLinks(links = []) {
  const uniq = uniqNameFactory();
  const proxies = [];
  for (const raw of links) {
    const p = parseLinkToClashProxy(raw, uniq);
    if (p) proxies.push(p);
  }


  const builtInBase = {
    'mixed-port': 7890,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'unified-delay': true,
    'tcp-concurrent': true,
    profile: {
      'store-selected': true,
      'store-fake-ip': true,
    },
    dns: {
      enable: true,
      listen: '127.0.0.1:1053',
      ipv6: false,
      'respect-rules': true,
      'enhanced-mode': 'fake-ip',
      'fake-ip-range': '198.18.0.1/16',
      'fake-ip-filter': [
        '*.lan',
        '*.local',
        'localhost.ptlogin2.qq.com',
        '*.msftconnecttest.com',
        '*.msftncsi.com',
        'time.*.com',
        'time.*.gov',
        'pool.ntp.org',
        '*.pool.ntp.org',
        '+.qq.com',
        '+.wechat.com',
        '+.weixin.qq.com',
        'geosite:cn',
        'geosite:apple',
        'geosite:microsoft@cn'
      ],
      'default-nameserver': ['1.1.1.1', '8.8.8.8'],
      'nameserver-policy': {
        'geosite:cn': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
        'geosite:geolocation-!cn': ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query']
      },
      nameserver: ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'],
      'proxy-server-nameserver': ['223.5.5.5', '119.29.29.29', 'https://1.1.1.1/dns-query', 'https://dns.google/dns-query'],
      'proxy-server-nameserver-policy': {
        'geosite:cn': ['223.5.5.5', '119.29.29.29'],
        '+.zzao.de': ['223.5.5.5', '119.29.29.29'],
        '+.fengqi0216.top': ['223.5.5.5', '119.29.29.29']
      },
      'direct-nameserver': ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query'],
      'direct-nameserver-follow-policy': true,
      fallback: ['https://1.1.1.1/dns-query', 'https://dns.google/dns-query'],
      'fallback-filter': {
        geoip: true,
        'geoip-code': 'CN',
        ipcidr: ['240.0.0.0/4']
      }
    },
    sniffer: {
      enable: true,
      sniff: {
        TLS: { ports: [443, 8443] },
        HTTP: { ports: [80, '8080-8880'] }
      },
      'skip-domain': [
        'Mijia Cloud',
        '+.push.apple.com',
        'connectivitycheck.gstatic.com',
        'connect.rom.miui.com',
        'time.android.com',
        '+.msftconnecttest.com',
        '+.msftncsi.com',
        '+.googlecast.com',
        'geosite:cn',
        'geosite:apple'
      ]
    },
    'proxy-groups': [
      { name: '节点选择', type: 'select', proxies: ['手动选择', '独立选择', '自动选择'] },
      { name: '手动选择', type: 'select', 'include-all-proxies': true, 'exclude-filter': '^(?i:(DIRECT|REJECT|PASS))$', proxies: [] },
      { name: '独立选择', type: 'select', 'include-all-proxies': true, 'exclude-filter': '^(?i:(DIRECT|REJECT|PASS))$', proxies: [] },
      { name: 'AI分流', type: 'select', 'include-all-proxies': true, 'exclude-filter': '^(?i:(DIRECT|REJECT|PASS))$', proxies: ['节点选择', '自动选择'] },
      { name: 'YouTube分流', type: 'select', 'include-all-proxies': true, 'exclude-filter': '^(?i:(DIRECT|REJECT|PASS))$', proxies: ['节点选择', '自动选择'] },
      { name: 'Telegram分流', type: 'select', 'include-all-proxies': true, 'exclude-filter': '^(?i:(DIRECT|REJECT|PASS))$', proxies: ['节点选择', '自动选择'] },
      { name: 'Google', type: 'select', 'include-all-proxies': true, 'exclude-filter': '^(?i:(DIRECT|REJECT|PASS))$', proxies: ['节点选择', '自动选择'] },
      { name: '自动选择', type: 'url-test', 'include-all-proxies': true, 'exclude-filter': '^(?i:(DIRECT|REJECT|PASS))$', proxies: [], url: 'https://cp.cloudflare.com/generate_204', interval: 600, tolerance: 100 }
    ],
    'rule-providers': {
      reject: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising_Classical.yaml', path: './ruleset/blackmatrix7/Advertising_Classical.yaml', interval: 86400 },
      direct: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/ChinaMax/ChinaMax_Classical.yaml', path: './ruleset/blackmatrix7/ChinaMax_Classical.yaml', interval: 86400 },
      proxy: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Global/Global_Classical.yaml', path: './ruleset/blackmatrix7/Global_Classical.yaml', interval: 86400 },
      openai: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/OpenAI/OpenAI.yaml', path: './ruleset/blackmatrix7/OpenAI.yaml', interval: 86400 },
      anthropic: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Anthropic/Anthropic.yaml', path: './ruleset/blackmatrix7/Anthropic.yaml', interval: 86400 },
      youtube: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/YouTube/YouTube.yaml', path: './ruleset/blackmatrix7/YouTube.yaml', interval: 86400 },
      telegram: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Telegram/Telegram.yaml', path: './ruleset/blackmatrix7/Telegram.yaml', interval: 86400 },
      google: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Google/Google.yaml', path: './ruleset/blackmatrix7/Google.yaml', interval: 86400 },
      my_whitelist: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/Spittingjiu/clash-custom-rules/main/my_whitelist.yaml', path: './ruleset/custom/my_whitelist.yaml', interval: 86400 },
      private: { type: 'http', behavior: 'classical', format: 'yaml', url: 'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Lan/Lan.yaml', path: './ruleset/blackmatrix7/Lan.yaml', interval: 86400 },
      cncidr: { type: 'http', behavior: 'ipcidr', format: 'text', url: 'https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/cncidr.txt', path: './ruleset/loyalsoldier/cncidr.txt', interval: 86400 },
      lancidr: { type: 'http', behavior: 'ipcidr', format: 'text', url: 'https://raw.githubusercontent.com/Loyalsoldier/clash-rules/release/lancidr.txt', path: './ruleset/loyalsoldier/lancidr.txt', interval: 86400 }
    },
    rules: [
      'RULE-SET,my_whitelist,DIRECT',
      'RULE-SET,reject,REJECT',
      'RULE-SET,private,DIRECT',
      'RULE-SET,lancidr,DIRECT,no-resolve',
      'RULE-SET,openai,AI分流',
      'RULE-SET,anthropic,AI分流',
      'RULE-SET,youtube,YouTube分流',
      'RULE-SET,telegram,Telegram分流',
      'RULE-SET,google,Google',
      'RULE-SET,proxy,节点选择',
      'GEOSITE,geolocation-!cn,节点选择',
      'RULE-SET,direct,DIRECT',
      'GEOSITE,cn,DIRECT',
      'RULE-SET,cncidr,DIRECT,no-resolve',
      'MATCH,节点选择'
    ]
  };

  const dynamicPart = {
    // 仅注入节点；其余（策略组/规则/DNS等）完全由模板决定
    proxies
  };

  const remoteBase = await loadRemoteClashTemplate({ forceRefresh: true });
  const templateBase = remoteBase || builtInBase;
  const cfg = { ...templateBase, ...dynamicPart };


  return toYaml(cfg) + '\n';
}


function getSubByToken(token) {
  return db.prepare('SELECT * FROM subscriptions WHERE token=?').get(token) || null;
}

function getSubNodeLinksBySub(sub) {
  if (!sub) return null;
  const sourceIds = (JSON.parse(sub.source_ids_json || '[]') || []).map(Number).filter(Boolean);
  const nodeIds = (JSON.parse(sub.node_ids_json || '[]') || []).map(Number).filter(Boolean);

  let rows = [];
  if (nodeIds.length) {
    const p = nodeIds.map(()=>'?').join(',');
    rows = db.prepare(`SELECT id,raw_link FROM nodes WHERE enabled=1 AND id IN (${p}) ORDER BY id DESC`).all(...nodeIds);
  } else if (sourceIds.length) {
    const p = sourceIds.map(()=>'?').join(',');
    rows = db.prepare(`SELECT id,raw_link FROM nodes WHERE enabled=1 AND source_id IN (${p}) ORDER BY id DESC`).all(...sourceIds);
  }
  return rows.map(x => x.raw_link);
}

function detectClientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (xff.length) return xff[0];
  const rip = String(req.headers['x-real-ip'] || '').trim();
  if (rip) return rip;
  return String(req.ip || req.socket?.remoteAddress || '').trim();
}

function detectDeviceHint(req, ua = '') {
  const s = String(ua || '').toLowerCase();
  const chPlatformRaw = String(req.headers['sec-ch-ua-platform'] || '').replaceAll('"', '').trim().toLowerCase();

  let os = 'unknown';
  if (s.includes('windows') || chPlatformRaw === 'windows') os = 'Windows';
  else if (s.includes('android') || chPlatformRaw === 'android') os = 'Android';
  else if (s.includes('iphone') || s.includes('ipad') || s.includes('ios') || chPlatformRaw === 'ios') os = 'iOS';
  else if (s.includes('mac os') || s.includes('macintosh') || chPlatformRaw === 'macos') os = 'macOS';
  else if (s.includes('linux') || chPlatformRaw === 'linux') os = 'Linux';

  let client = '';
  if (s.includes('clash verge')) client = 'Clash Verge';
  else if (s.includes('mihomo')) client = 'Mihomo';
  else if (s.includes('clash.meta')) client = 'Clash.Meta';
  else if (s.includes('clash')) client = 'Clash';
  else if (s.includes('quantumult x')) client = 'Quantumult X';
  else if (s.includes('surge')) client = 'Surge';
  else if (s.includes('loon')) client = 'Loon';

  if (os !== 'unknown' && client) return `${os} (${client})`;
  if (os !== 'unknown') return os;
  if (client) return client;
  return 'unknown';
}

function recordSubscriptionLog(req, sub, routeType) {
  try {
    const ua = String(req.headers['user-agent'] || '');
    db.prepare(`INSERT INTO subscription_logs(token,subscription_id,subscription_name,route_type,client_ip,user_agent,device_hint,created_at) VALUES(?,?,?,?,?,?,?,?)`).run(
      String(sub?.token || ''),
      Number(sub?.id || 0) || null,
      String(sub?.name || ''),
      String(routeType || 'unknown'),
      detectClientIp(req),
      ua,
      detectDeviceHint(req, ua),
      now()
    );
    db.prepare(`DELETE FROM subscription_logs WHERE id NOT IN (SELECT id FROM subscription_logs ORDER BY id DESC LIMIT 10)`).run();
  } catch (_e) {}
}

app.get('/sub/:token', (req, res) => {
  const sub = getSubByToken(req.params.token);
  if (!sub) return res.status(404).send('not found');
  const links = getSubNodeLinksBySub(sub);
  recordSubscriptionLog(req, sub, 'plain-base64');
  const encoded = Buffer.from((links || []).join('\n'), 'utf8').toString('base64');
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.send(encoded);
});

app.get('/api/sub/:token/plain', (req, res) => {
  const sub = getSubByToken(req.params.token);
  if (!sub) return res.status(404).send('not found');
  const links = getSubNodeLinksBySub(sub);
  recordSubscriptionLog(req, sub, 'plain');
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.send((links || []).join('\n'));
});


app.get('/sub/:token/singbox', async (req, res) => {
  try {
    const sub = getSubByToken(req.params.token);
    if (!sub) return res.status(404).send('not found');
    const links = getSubNodeLinksBySub(sub);
    recordSubscriptionLog(req, sub, 'singbox');
    const json = await buildSingboxConfigByLinks(links || []);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(json, null, 2));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sub/:token/singbox', async (req, res) => {
  try {
    const sub = getSubByToken(req.params.token);
    if (!sub) return res.status(404).send('not found');
    const links = getSubNodeLinksBySub(sub);
    recordSubscriptionLog(req, sub, 'singbox-api');
    const json = await buildSingboxConfigByLinks(links || []);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(json, null, 2));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/sub/:token/clash', async (req, res) => {
  const sub = getSubByToken(req.params.token);
  if (!sub) return res.status(404).send('not found');
  const links = getSubNodeLinksBySub(sub);
  recordSubscriptionLog(req, sub, 'clash');
  const yaml = await buildClashConfigByLinks(links || []);
  res.setHeader('content-type', 'text/yaml; charset=utf-8');
  res.send(yaml);
});

app.get('/api/sub/:token/clash', async (req, res) => {
  const sub = getSubByToken(req.params.token);
  if (!sub) return res.status(404).send('not found');
  const links = getSubNodeLinksBySub(sub);
  recordSubscriptionLog(req, sub, 'clash-api');
  const yaml = await buildClashConfigByLinks(links || []);
  res.setHeader('content-type', 'text/yaml; charset=utf-8');
  res.send(yaml);
});


app.use(express.static(path.join(__dirname, 'public')));

ensureLocalSource();
migrateLocalNodeDisplayNames();

app.listen(PORT, () => {
  console.log(`sui-sub listening on :${PORT}`);
  autoSyncAll().catch(() => {});
  setInterval(() => autoSyncAll().catch(() => {}), AUTO_SYNC_MS);
});
