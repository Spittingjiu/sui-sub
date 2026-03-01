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
const E2EE_KEYS_FILE = path.join(__dirname, 'data', 'e2ee-keys.json');



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
  password TEXT NOT NULL
);
`);

const sourceCols = db.prepare(`PRAGMA table_info(sources)`).all().map(x => x.name);
const hasTokenUrlCol = sourceCols.includes('token_url');
const hasSourceTypeCol = sourceCols.includes('source_type');
if (!sourceCols.includes('panel_token')) db.exec(`ALTER TABLE sources ADD COLUMN panel_token TEXT NOT NULL DEFAULT ''`);
if (!sourceCols.includes('last_sync_at')) db.exec(`ALTER TABLE sources ADD COLUMN last_sync_at TEXT`);
if (!sourceCols.includes('last_sync_status')) db.exec(`ALTER TABLE sources ADD COLUMN last_sync_status TEXT`);
const subCols = db.prepare(`PRAGMA table_info(subscriptions)`).all().map(x => x.name);
if (!subCols.includes('node_ids_json')) db.exec(`ALTER TABLE subscriptions ADD COLUMN node_ids_json TEXT NOT NULL DEFAULT '[]'`);

const rowAdmin = db.prepare('SELECT * FROM admin_settings WHERE id=1').get();
if (!rowAdmin) {
  db.prepare('INSERT INTO admin_settings(id,username,password) VALUES(1,?,?)').run(ADMIN_USER, ADMIN_PASS);
}
function getAdminSettings(){
  return db.prepare('SELECT username,password FROM admin_settings WHERE id=1').get() || { username: ADMIN_USER, password: ADMIN_PASS };
}
function setAdminSettings(username,password){
  db.prepare('UPDATE admin_settings SET username=?, password=? WHERE id=1').run(username,password);
}


function insertSourceRow(name, panel_url, panel_token) {
  if (hasTokenUrlCol && hasSourceTypeCol) {
    const ins = db.prepare('INSERT INTO sources(name,panel_url,token_url,source_type,panel_token,last_sync_at,last_sync_status,created_at) VALUES(?,?,?,?,?,?,?,?)');
    return ins.run(name, panel_url, '', 'sui_api', panel_token, null, 'pending', now());
  }
  if (hasTokenUrlCol) {
    const ins = db.prepare('INSERT INTO sources(name,panel_url,token_url,panel_token,last_sync_at,last_sync_status,created_at) VALUES(?,?,?,?,?,?,?)');
    return ins.run(name, panel_url, '', panel_token, null, 'pending', now());
  }
  const ins = db.prepare('INSERT INTO sources(name,panel_url,panel_token,last_sync_at,last_sync_status,created_at) VALUES(?,?,?,?,?,?)');
  return ins.run(name, panel_url, panel_token, null, 'pending', now());
}

app.use(express.json({ limit: '1mb' }));

const now = () => new Date().toISOString();

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
    const sources = db.prepare('SELECT id FROM sources ORDER BY id ASC').all();
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
  res.json({ ok: true, username: adm.username });
});

app.post('/api/admin/user', (req, res) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username) return res.status(400).json({ ok: false, error: 'username 必填' });
    if (!password || password.length < 6) return res.status(400).json({ ok: false, error: 'password 至少6位' });
    setAdminSettings(username, password);
    res.json({ ok: true });
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
      db.prepare('INSERT INTO subscriptions(name,token,source_ids_json,node_ids_json,created_at) VALUES(?,?,?,?,?)')
        .run(`${name}-default`, crypto.randomBytes(18).toString('base64url'), JSON.stringify([source_id]), '[]', now());
    }
    syncSource(source_id).catch(()=>{});
    res.json({ ok: true, source_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/sources', (req, res) => {
  const sources = db.prepare('SELECT * FROM sources ORDER BY id DESC').all();
  res.json({ ok: true, sources });
});

app.post('/api/sources', async (req, res) => {
  try {
    const { name, panel_url, panel_token } = req.body || {};
    if (!name || !panel_url || !panel_token) return res.status(400).json({ ok: false, error: 'name / panel_url / panel_token 必填' });

    const result = insertSourceRow(name.trim(), panel_url.trim(), panel_token.trim());
    const source_id = Number(result.lastInsertRowid);

    // 新源默认生成一个独立订阅链接
    db.prepare('INSERT INTO subscriptions(name,token,source_ids_json,node_ids_json,created_at) VALUES(?,?,?,?,?)')
      .run(`${name}-default`, crypto.randomBytes(18).toString('base64url'), JSON.stringify([source_id]), '[]', now());

    // 立即同步一次（异步）
    syncSource(source_id).catch((e) => {
      db.prepare('UPDATE sources SET last_sync_at=?, last_sync_status=? WHERE id=?').run(now(), `error: ${String(e.message || e).slice(0, 160)}`, source_id);
    });

    res.json({ ok: true, source_id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/sources/:id', (req, res) => {
  const id = Number(req.params.id);
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
  res.json({ ok: true });
});

app.post('/api/sources/sync-all', async (_req, res) => {
  await autoSyncAll();
  res.json({ ok: true });
});


// backend-view endpoints: keep business aggregation on server side
app.get('/api/view/home', (_req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COALESCE(COUNT(n.id),0) AS node_count
    FROM sources s
    LEFT JOIN nodes n ON n.source_id=s.id
    GROUP BY s.id
    ORDER BY s.id DESC
  `).all();
  res.json({ ok: true, sources: rows });
});

app.get('/api/view/nodes', (req, res) => {
  const sourceId = Number(req.query.sourceId || 0);
  let rows;
  if (sourceId > 0) {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE n.source_id=?
      ORDER BY n.id DESC
    `).all(sourceId);
  } else {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      ORDER BY n.id DESC
    `).all();
  }
  res.json({ ok: true, nodes: rows });
});


app.get('/api/view/bootstrap', (req, res) => {
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

  res.json({ ok: true, sources, nodes, subscriptions });
});

app.get('/api/view/modal-nodes', (req, res) => {
  const sourceId = Number(req.query.sourceId || 0);
  let rows;
  if (sourceId > 0) {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE n.source_id=?
      ORDER BY n.id DESC
    `).all(sourceId);
  } else {
    rows = db.prepare(`
      SELECT n.*, s.name as source_name
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      ORDER BY n.id DESC
    `).all();
  }
  res.json({ ok: true, nodes: rows });
});

app.get('/api/view/subscriptions', (req, res) => {
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
  res.json({ ok: true, subscriptions: out });
});


app.get('/api/sui/:sourceId/inbounds', async (req, res) => {
  try {
    const sourceId = Number(req.params.sourceId);
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
    if (!source) return res.status(404).json({ ok: false, error: 'source not found' });
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
  res.json({ ok: true, enabled: next });
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
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/subscriptions/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM subscriptions WHERE id=?').run(id);
  res.json({ ok: true });
});

function getSubNodeLinksByToken(token) {
  const sub = db.prepare('SELECT * FROM subscriptions WHERE token=?').get(token);
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

app.get('/sub/:token', (req, res) => {
  const links = getSubNodeLinksByToken(req.params.token);
  if (links === null) return res.status(404).send('not found');
  const encoded = Buffer.from(links.join('\n'), 'utf8').toString('base64');
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.send(encoded);
});

app.get('/api/sub/:token/plain', (req, res) => {
  const links = getSubNodeLinksByToken(req.params.token);
  if (links === null) return res.status(404).send('not found');
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.send(links.join('\n'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`sui-sub listening on :${PORT}`);
  autoSyncAll().catch(() => {});
  setInterval(() => autoSyncAll().catch(() => {}), AUTO_SYNC_MS);
});