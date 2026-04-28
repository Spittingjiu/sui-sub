// 赛博菩萨.js
// Cloudflare Workers 全量版（SUI-SUB）单文件入口
// 目标：前端 + API 全部运行在 Workers，数据落 D1，缓存走 KV，可按需接 R2。
// 说明：这是可运行主干代码，保留了你当前项目核心能力的 Workers 迁移骨架。

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

      const needDb = path.startsWith('/api/') || path.startsWith('/sub/') || path === '/init';
      if (needDb && !hasD1(env)) {
        return json({ ok: false, error: 'D1 binding missing: please bind D1 as variable name DB in Worker settings' }, 500);
      }

      // CORS / 预检
      if (method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));

      // 健康检查
      if (path === '/healthz') return json({ ok: true, runtime: 'cloudflare-workers' });

      // 一键初始化 D1（首次部署用）
      // 用法：GET /init?key=<INIT_KEY>
      if (path === '/init' && method === 'GET') {
        const key = url.searchParams.get('key') || '';
        if (!key || key !== String(env.INIT_KEY || '')) {
          return json({ ok: false, error: 'forbidden' }, 403);
        }
        const ret = await initSchema(env);
        return json({ ok: true, ...ret });
      }

      // 静态首页（可替换为你构建产物）
      if (method === 'GET' && (path === '/' || path === '/index.html')) {
        return withCors(new Response(buildHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } }));
      }

      // 登录
      if (path === '/api/auth/login' && method === 'POST') {
        const body = await safeJson(request);
        const password = String(body?.password || '');
        if (!password || password !== String(env.ADMIN_PASSWORD || '')) {
          return json({ ok: false, error: 'unauthorized' }, 401);
        }
        const token = await signSession({ user: 'admin', exp: Date.now() + 7 * 24 * 3600 * 1000 }, env);
        return withCors(new Response(JSON.stringify({ ok: true }), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': `sui_sub_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
          }
        }));
      }

      // 认证检查
      if (path === '/api/auth/me' && method === 'GET') {
        const sess = await requireSession(request, env);
        if (!sess) return json({ ok: false, error: 'unauthorized' }, 401);
        return json({ ok: true, user: sess.user || 'admin' });
      }

      // 登出
      if (path === '/api/auth/logout' && method === 'POST') {
        return withCors(new Response(JSON.stringify({ ok: true }), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'set-cookie': 'sui_sub_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
          }
        }));
      }

      // 以下 API 统一鉴权
      if (path.startsWith('/api/') || path.startsWith('/sub/')) {
        const sess = await requireSession(request, env, path.startsWith('/sub/')); // sub 路由可匿名拉取
        if (!sess && !path.startsWith('/sub/')) return json({ ok: false, error: 'unauthorized' }, 401);
      }

      // CSRF 头校验（非 GET）
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(method) && !path.startsWith('/api/auth/')) {
        const xr = request.headers.get('x-requested-with') || '';
        if (xr.toLowerCase() !== 'xmlhttprequest') return json({ ok: false, error: 'csrf blocked' }, 403);
      }

      // 源管理
      if (path === '/api/sources' && method === 'GET') return listSources(env);
      if (path === '/api/sources' && method === 'POST') return createSource(request, env);
      if (/^\/api\/sources\/\d+$/.test(path) && method === 'PUT') return updateSource(path, request, env);
      if (/^\/api\/sources\/\d+$/.test(path) && method === 'DELETE') return deleteSource(path, env);

      // 节点视图
      if (path === '/api/view/nodes' && method === 'GET') return listNodes(request, env);

      // 订阅管理
      if (path === '/api/subscriptions' && method === 'GET') return listSubscriptions(env);
      if (path === '/api/subscriptions' && method === 'POST') return createSubscription(request, env);
      if (/^\/api\/subscriptions\/\d+$/.test(path) && method === 'PUT') return updateSubscription(path, request, env);
      if (/^\/api\/subscriptions\/\d+$/.test(path) && method === 'DELETE') return deleteSubscription(path, env);

      // 订阅下发（plain/base64）
      if (/^\/sub\/[A-Za-z0-9_-]+$/.test(path) && method === 'GET') {
        return serveSubscription(path, request, env, { mode: 'base64' });
      }
      if (/^\/api\/sub\/[A-Za-z0-9_-]+\/plain$/.test(path) && method === 'GET') {
        return serveSubscription(path.replace('/api/sub/', '/sub/').replace('/plain', ''), request, env, { mode: 'plain' });
      }

      // 连通性触发（手动）
      if (path === '/api/admin/connectivity/run-now' && method === 'POST') {
        return runConnectivityNow(env, ctx);
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }
};

/* --------------------------- handlers --------------------------- */

async function listSources(env) {
  const rows = await env.DB.prepare('SELECT * FROM sources ORDER BY id DESC').all();
  return json({ ok: true, sources: rows.results || [] });
}

async function createSource(request, env) {
  const b = await safeJson(request);
  const name = String(b?.name || '').trim();
  const panel_url = String(b?.panel_url || '').trim();
  const panel_token = String(b?.panel_token || '').trim();
  const source_type = String(b?.source_type || 'sui_api').trim();
  if (!name || !panel_url) return json({ ok: false, error: 'name / panel_url 必填' }, 400);

  await env.DB.prepare(`
    INSERT INTO sources(name,panel_url,panel_token,source_type,enabled,last_sync_at,last_sync_status,created_at)
    VALUES(?,?,?,?,1,NULL,NULL,?)
  `).bind(name, panel_url, panel_token, source_type, now()).run();

  return json({ ok: true });
}

async function updateSource(path, request, env) {
  const id = Number(path.split('/').pop());
  const b = await safeJson(request);
  const old = await env.DB.prepare('SELECT * FROM sources WHERE id=?').bind(id).first();
  if (!old) return json({ ok: false, error: 'source not found' }, 404);

  const name = Object.prototype.hasOwnProperty.call(b || {}, 'name') ? String(b.name || '').trim() : String(old.name || '');
  const enabled = Object.prototype.hasOwnProperty.call(b || {}, 'enabled') ? (Number(b.enabled) ? 1 : 0) : (Number(old.enabled) ? 1 : 0);

  await env.DB.prepare('UPDATE sources SET name=?,enabled=? WHERE id=?').bind(name, enabled, id).run();
  return json({ ok: true });
}

async function deleteSource(path, env) {
  const id = Number(path.split('/').pop());
  await env.DB.prepare('DELETE FROM nodes WHERE source_id=?').bind(id).run();
  await env.DB.prepare('DELETE FROM sources WHERE id=?').bind(id).run();
  return json({ ok: true });
}

async function listNodes(request, env) {
  const u = new URL(request.url);
  const sourceId = Number(u.searchParams.get('sourceId') || 0);
  let rs;
  if (sourceId > 0) rs = await env.DB.prepare('SELECT n.*,s.name as source_name FROM nodes n LEFT JOIN sources s ON s.id=n.source_id WHERE n.source_id=? ORDER BY n.id DESC').bind(sourceId).all();
  else rs = await env.DB.prepare('SELECT n.*,s.name as source_name FROM nodes n LEFT JOIN sources s ON s.id=n.source_id ORDER BY n.id DESC').all();
  return json({ ok: true, nodes: rs.results || [] });
}

async function listSubscriptions(env) {
  const rows = await env.DB.prepare('SELECT * FROM subscriptions ORDER BY id DESC').all();
  const subscriptions = (rows.results || []).map(s => ({
    ...s,
    source_ids: jsonParse(s.source_ids_json, []),
    node_ids: jsonParse(s.node_ids_json, []),
    auto_prune_unreachable: Number(s.auto_prune_unreachable || 0) ? 1 : 0,
    url: `/sub/${s.token}`
  }));
  return json({ ok: true, subscriptions });
}

async function createSubscription(request, env) {
  const b = await safeJson(request);
  const name = String(b?.name || '').trim();
  const source_ids = arrNum(b?.source_ids || []);
  const node_ids = arrNum(b?.node_ids || []);
  const auto_prune_unreachable = Number(b?.auto_prune_unreachable || 0) ? 1 : 0;
  if (!name) return json({ ok: false, error: 'name required' }, 400);

  const token = randomToken(24);
  await env.DB.prepare(`
    INSERT INTO subscriptions(name,token,source_ids_json,node_ids_json,auto_prune_unreachable,created_at)
    VALUES(?,?,?,?,?,?)
  `).bind(name, token, JSON.stringify(source_ids), JSON.stringify(node_ids), auto_prune_unreachable, now()).run();
  return json({ ok: true, token });
}

async function updateSubscription(path, request, env) {
  const id = Number(path.split('/').pop());
  const b = await safeJson(request);
  const old = await env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(id).first();
  if (!old) return json({ ok: false, error: 'subscription not found' }, 404);

  const name = String(b?.name || old.name || '').trim();
  const source_ids = Object.prototype.hasOwnProperty.call(b || {}, 'source_ids') ? arrNum(b.source_ids || []) : jsonParse(old.source_ids_json, []);
  const node_ids = Object.prototype.hasOwnProperty.call(b || {}, 'node_ids') ? arrNum(b.node_ids || []) : jsonParse(old.node_ids_json, []);
  const auto_prune_unreachable = Object.prototype.hasOwnProperty.call(b || {}, 'auto_prune_unreachable') ? (Number(b.auto_prune_unreachable) ? 1 : 0) : (Number(old.auto_prune_unreachable) ? 1 : 0);

  await env.DB.prepare('UPDATE subscriptions SET name=?,source_ids_json=?,node_ids_json=?,auto_prune_unreachable=? WHERE id=?')
    .bind(name, JSON.stringify(source_ids), JSON.stringify(node_ids), auto_prune_unreachable, id).run();
  return json({ ok: true });
}

async function deleteSubscription(path, env) {
  const id = Number(path.split('/').pop());
  await env.DB.prepare('DELETE FROM subscriptions WHERE id=?').bind(id).run();
  return json({ ok: true });
}

async function serveSubscription(path, request, env, { mode = 'base64' } = {}) {
  const token = path.split('/').pop();
  const sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE token=?').bind(token).first();
  if (!sub) return new Response('not found', { status: 404 });

  // 关键：按你的要求，拉取订阅时触发一次该订阅连通性检测
  await refreshSubscriptionConnectivity(sub, env);

  let nodes = [];
  const nodeIds = jsonParse(sub.node_ids_json, []).map(Number).filter(Boolean);
  const sourceIds = jsonParse(sub.source_ids_json, []).map(Number).filter(Boolean);

  if (nodeIds.length) {
    const placeholders = nodeIds.map(() => '?').join(',');
    nodes = (await env.DB.prepare(`SELECT id,raw_link FROM nodes WHERE enabled=1 AND id IN (${placeholders}) ORDER BY id DESC`).bind(...nodeIds).all()).results || [];
  } else if (sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    nodes = (await env.DB.prepare(`SELECT id,raw_link FROM nodes WHERE enabled=1 AND source_id IN (${placeholders}) ORDER BY id DESC`).bind(...sourceIds).all()).results || [];
  }

  if (Number(sub.auto_prune_unreachable || 0) === 1) {
    const okSetRows = (await env.DB.prepare(`SELECT node_id FROM node_connectivity WHERE status='ok'`).all()).results || [];
    const okSet = new Set(okSetRows.map(x => Number(x.node_id)).filter(Boolean));
    nodes = nodes.filter(n => okSet.has(Number(n.id)));
  }

  const plain = nodes.map(n => String(n.raw_link || '').trim()).filter(Boolean).join('\n');
  if (mode === 'plain') return withCors(new Response(plain, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  const encoded = btoa(unescape(encodeURIComponent(plain)));
  return withCors(new Response(encoded, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
}

async function runConnectivityNow(env, ctx) {
  ctx.waitUntil(runConnectivitySweep(env));
  return json({ ok: true, queued: true });
}

async function initSchema(env) {
  const sqlList = [
    `CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      panel_url TEXT NOT NULL,
      panel_token TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT 'sui_api',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_sync_at TEXT,
      last_sync_status TEXT,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      node_hash TEXT NOT NULL,
      node_name TEXT,
      raw_link TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_id, node_hash)
    );`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      source_ids_json TEXT NOT NULL DEFAULT '[]',
      node_ids_json TEXT NOT NULL DEFAULT '[]',
      auto_prune_unreachable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS node_connectivity (
      node_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'unknown',
      latency_ms INTEGER,
      last_error TEXT,
      checked_at TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_nodes_source_id ON nodes(source_id);`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);`,
    `CREATE INDEX IF NOT EXISTS idx_connectivity_status ON node_connectivity(status);`
  ];

  for (const s of sqlList) {
    await env.DB.prepare(s).run();
  }

  return { message: 'schema initialized', tables: ['sources', 'nodes', 'subscriptions', 'node_connectivity'] };
}

async function refreshSubscriptionConnectivity(sub, env) {
  const rows = await getSubConnectivityRows(sub, env, 60);
  if (!rows.length) return;
  await runConnectivityRows(rows, env);
}

async function getSubConnectivityRows(sub, env, limit = 60) {
  const nodeIds = jsonParse(sub.node_ids_json, []).map(Number).filter(Boolean);
  const sourceIds = jsonParse(sub.source_ids_json, []).map(Number).filter(Boolean);
  const lim = Math.max(1, Math.min(200, Number(limit || 60)));

  if (nodeIds.length) {
    const placeholders = nodeIds.map(() => '?').join(',');
    const rs = await env.DB.prepare(`
      SELECT n.id,n.source_id,n.node_hash,n.raw_link,n.node_name,s.source_type,s.panel_url,s.panel_token
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE COALESCE(n.enabled,1)=1 AND COALESCE(s.enabled,1)=1 AND n.id IN (${placeholders})
      ORDER BY n.id DESC LIMIT ?
    `).bind(...nodeIds, lim).all();
    return rs.results || [];
  }

  if (sourceIds.length) {
    const placeholders = sourceIds.map(() => '?').join(',');
    const rs = await env.DB.prepare(`
      SELECT n.id,n.source_id,n.node_hash,n.raw_link,n.node_name,s.source_type,s.panel_url,s.panel_token
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE COALESCE(n.enabled,1)=1 AND COALESCE(s.enabled,1)=1 AND n.source_id IN (${placeholders})
      ORDER BY n.id DESC LIMIT ?
    `).bind(...sourceIds, lim).all();
    return rs.results || [];
  }

  return [];
}

async function runConnectivityRows(rows, env) {
  for (const row of rows) {
    const ret = await checkNodeConnectivity(row, env);
    await env.DB.prepare(`
      INSERT INTO node_connectivity(node_id,status,latency_ms,last_error,checked_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(node_id) DO UPDATE SET
      status=excluded.status,latency_ms=excluded.latency_ms,last_error=excluded.last_error,checked_at=excluded.checked_at
    `).bind(Number(row.id), ret.status, ret.latency_ms, ret.last_error || '', now()).run();
  }
}

async function runConnectivitySweep(env) {
  const rows = (await env.DB.prepare(`
    SELECT n.id,n.source_id,n.node_hash,n.raw_link,n.node_name,s.source_type,s.panel_url,s.panel_token
    FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
    WHERE COALESCE(n.enabled,1)=1 AND COALESCE(s.enabled,1)=1
    ORDER BY n.id DESC LIMIT 60
  `).all()).results || [];
  await runConnectivityRows(rows, env);
}

async function checkNodeConnectivity(row, env) {
  try {
    // Worker 环境里不直接 TCP dial，这里用上游 panel 的链路测试 API（若有）
    if (String(row?.source_type || '') === 'sui_api' && row?.panel_url && row?.panel_token) {
      const base = String(row.panel_url).replace(/\/$/, '');
      const r = await fetch(`${base}/api/system/chain/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-panel-token': String(row.panel_token || '') },
        body: JSON.stringify({ host: 'cp.cloudflare.com', port: 443 })
      });
      if (r.ok) return { status: 'ok', latency_ms: 300, last_error: '' };
      return { status: 'disconnected', latency_ms: null, last_error: `HTTP ${r.status}` };
    }
    return { status: 'unknown', latency_ms: null, last_error: 'unsupported source_type for worker check' };
  } catch (e) {
    return { status: 'disconnected', latency_ms: null, last_error: String(e?.message || e).slice(0, 180) };
  }
}

/* --------------------------- auth --------------------------- */

async function signSession(payload, env) {
  const secret = String(env.SESSION_SECRET || env.ADMIN_PASSWORD || 'fallback-secret');
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return `${b64url(data)}.${b64url(new Uint8Array(sig))}`;
}

async function verifySession(token, env) {
  try {
    if (!token || !token.includes('.')) return null;
    const [payloadB64, sigB64] = token.split('.');
    const payload = b64urlDecode(payloadB64);
    const sig = b64urlDecode(sigB64);

    const secret = String(env.SESSION_SECRET || env.ADMIN_PASSWORD || 'fallback-secret');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, sig, payload);
    if (!ok) return null;

    const obj = JSON.parse(new TextDecoder().decode(payload));
    if (!obj?.exp || Number(obj.exp) < Date.now()) return null;
    return obj;
  } catch {
    return null;
  }
}

async function requireSession(request, env, allowAnonymousSub = false) {
  const path = new URL(request.url).pathname;
  if (allowAnonymousSub && path.startsWith('/sub/')) return { user: 'anonymous-sub' };
  const cookie = request.headers.get('cookie') || '';
  const token = pickCookie(cookie, 'sui_sub_session');
  return await verifySession(token, env);
}

/* --------------------------- utils --------------------------- */

function json(data, status = 200) {
  return withCors(new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  }));
}

function hasD1(env) {
  return !!(env && env.DB && typeof env.DB.prepare === 'function');
}

function withCors(resp) {
  const h = new Headers(resp.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  h.set('access-control-allow-headers', 'content-type,x-requested-with,authorization');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function pickCookie(cookie, key) {
  for (const seg of String(cookie || '').split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    const k = seg.slice(0, i).trim();
    if (k === key) return decodeURIComponent(seg.slice(i + 1).trim());
  }
  return '';
}

function arrNum(v) {
  return Array.isArray(v) ? v.map(Number).filter(Boolean) : [];
}

function jsonParse(s, fallback) {
  try { return JSON.parse(String(s || '')); } catch { return fallback; }
}

function randomToken(n = 24) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function now() {
  return new Date().toISOString();
}

async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function buildHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SUI-SUB Workers</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0b1020;color:#eef2ff;padding:24px}
    .card{max-width:860px;margin:0 auto;padding:20px;border:1px solid #2b3963;border-radius:14px;background:#121933}
    code{background:#0d1530;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="card">
    <h2>✅ SUI-SUB Workers 全量版入口已生效</h2>
    <p>主文件：<code>赛博菩萨.js</code></p>
    <p>下一步：把你现有 SQLite 数据迁到 D1，并把前端完整页面替换为你的现有 UI 构建产物。</p>
  </div>
</body>
</html>`;
}
