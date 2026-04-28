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

      if (path === '/api/auth/status' && method === 'GET') {
        const adm = await getAdminSettings(env);
        return json({ ok: true, need_register: !adm });
      }

      // 注册（仅首次可用）
      if (path === '/api/auth/register' && method === 'POST') {
        return registerAdmin(request, env);
      }

      // 登录
      if (path === '/api/auth/login' && method === 'POST') {
        const body = await safeJson(request);
        const username = String(body?.username || '').trim();
        const password = String(body?.password || '');
        const adm = await getAdminSettings(env);
        if (!adm) return json({ ok: false, error: '未注册，请先注册管理员账号' }, 400);
        if (!username || !password || username !== String(adm?.username || '') || password !== String(adm?.password || '')) {
          return json({ ok: false, error: '用户名或密码错误' }, 401);
        }
        const token = await signSession({ user: username, exp: Date.now() + 7 * 24 * 3600 * 1000 }, env);
        return withCors(new Response(JSON.stringify({ ok: true, username }), {
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

      // 以下 API 统一鉴权（订阅下发路由允许匿名）
      const isAnonymousSubRoute = path.startsWith('/sub/') || /^\/api\/sub\/[A-Za-z0-9_-]+\/(plain|clash)$/.test(path);
      if (path.startsWith('/api/') || path.startsWith('/sub/')) {
        const sess = await requireSession(request, env, isAnonymousSubRoute);
        if (!sess && !isAnonymousSubRoute) return json({ ok: false, error: 'unauthorized' }, 401);
      }

      // CSRF 头校验（非 GET）
      if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(method) && !path.startsWith('/api/auth/')) {
        const xr = request.headers.get('x-requested-with') || '';
        if (xr.toLowerCase() !== 'xmlhttprequest') return json({ ok: false, error: 'csrf blocked' }, 403);
      }

      if (path === '/api/kernel/status' && method === 'GET') return json({ ok: true, installed: false, version: '', path: 'workers-no-local-binary' });
      if (path === '/api/kernel/install' && method === 'POST') return json({ ok: false, error: 'workers mode does not support local kernel install' }, 400);
      if (path === '/api/kernel/uninstall' && method === 'POST') return json({ ok: true, installed: false });

      // 源管理
      if (path === '/api/sources' && method === 'GET') return listSources(env);
      if (path === '/api/sources' && method === 'POST') return createSource(request, env);
      if (/^\/api\/sources\/\d+$/.test(path) && method === 'PUT') return updateSource(path, request, env);
      if (/^\/api\/sources\/\d+$/.test(path) && method === 'DELETE') return deleteSource(path, env);

      // 节点视图
      if (path === '/api/view/nodes' && method === 'GET') return listNodes(request, env);
      if (path === '/api/view/modal-nodes' && method === 'GET') return listNodes(request, env);
      if (path === '/api/view/subscriptions' && method === 'GET') return listSubscriptionsView(request, env);
      if (path === '/api/view/bootstrap' && method === 'GET') return bootstrapView(request, env);
      if (path === '/api/nodes/connectivity/check' && method === 'POST') return checkConnectivityBatch(request, env);
      if (/^\/api\/nodes\/\d+\/toggle$/.test(path) && method === 'POST') return toggleNodeEnabled(path, env);
      if (/^\/api\/nodes\/\d+\/rename$/.test(path) && method === 'PUT') return renameNode(path, request, env);
      if (path === '/api/local-nodes' && method === 'POST') return addLocalNode(request, env);
      if (/^\/api\/local-nodes\/\d+$/.test(path) && method === 'DELETE') return deleteLocalNode(path, env);

      // SUI 源管理接口（Workers 下以 source.panel_url + token 直连）
      if (/^\/api\/sui\/\d+\/inbounds$/.test(path) && method === 'GET') return listSuiInbounds(path, env);
      if (/^\/api\/sui\/\d+\/reality-quick$/.test(path) && method === 'POST') return quickCreateSuiReality(path, request, env);
      if (/^\/api\/sui\/\d+\/inbounds\/\d+\/rename$/.test(path) && method === 'PUT') return renameSuiInbound(path, request, env);
      if (/^\/api\/sui\/\d+\/inbounds\/\d+$/.test(path) && method === 'DELETE') return deleteSuiInbound(path, env);

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
      if (/^\/sub\/[A-Za-z0-9_-]+\/clash$/.test(path) && method === 'GET') {
        return serveSubscription(path.replace('/clash', ''), request, env, { mode: 'clash' });
      }
      if (/^\/api\/sub\/[A-Za-z0-9_-]+\/clash$/.test(path) && method === 'GET') {
        return serveSubscription(path.replace('/api/sub/', '/sub/').replace('/clash', ''), request, env, { mode: 'clash' });
      }

      if (path === '/api/admin/user' && method === 'GET') return getAdminUser(env);
      if (path === '/api/admin/user' && method === 'POST') return saveAdminUser(request, env);
      if (path === '/api/admin/subscription-logs' && method === 'GET') return listSubLogs(request, env);

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
  const srcRows = await env.DB.prepare('SELECT id,name FROM sources').all();
  const nodeRows = await env.DB.prepare('SELECT id,node_name,source_id FROM nodes').all();
  const sourceMap = new Map((srcRows.results || []).map(x => [Number(x.id), String(x.name || '')]));
  const nodeMap = new Map((nodeRows.results || []).map(x => [Number(x.id), x]));
  const subscriptions = (rows.results || []).map(s => {
    const source_ids = jsonParse(s.source_ids_json, []).map(Number).filter(Boolean);
    const node_ids = jsonParse(s.node_ids_json, []).map(Number).filter(Boolean);
    return {
      ...s,
      source_ids,
      source_names: source_ids.map(i => sourceMap.get(i)).filter(Boolean),
      node_ids,
      node_names: node_ids.map(i => nodeMap.get(i)?.node_name || `#${i}`).filter(Boolean),
      auto_prune_unreachable: Number(s.auto_prune_unreachable || 0) ? 1 : 0,
      url: `/sub/${s.token}`
    };
  });
  return json({ ok: true, subscriptions });
}

function getPublicBaseUrl(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

async function listSubscriptionsView(request, env) {
  const rows = await env.DB.prepare('SELECT * FROM subscriptions ORDER BY id DESC').all();
  const srcRows = await env.DB.prepare('SELECT id,name FROM sources').all();
  const sourceMap = new Map((srcRows.results || []).map(x => [Number(x.id), String(x.name || '')]));
  const base = getPublicBaseUrl(request);

  const subscriptions = (rows.results || []).map(s => {
    const source_ids = jsonParse(s.source_ids_json, []).map(Number).filter(Boolean);
    const node_ids = jsonParse(s.node_ids_json, []).map(Number).filter(Boolean);
    const url = `/sub/${s.token}`;
    return {
      id: Number(s.id),
      name: String(s.name || ''),
      source_ids,
      source_names: source_ids.map(i => sourceMap.get(i)).filter(Boolean),
      node_ids,
      auto_prune_unreachable: Number(s.auto_prune_unreachable || 0) ? 1 : 0,
      url,
      full_url: `${base}${url}`
    };
  });

  return json({ ok: true, subscriptions });
}

async function bootstrapView(request, env) {
  const [src, nodes] = await Promise.all([
    env.DB.prepare(`SELECT s.*, COALESCE(COUNT(n.id),0) AS node_count FROM sources s LEFT JOIN nodes n ON n.source_id=s.id GROUP BY s.id ORDER BY s.id DESC`).all(),
    env.DB.prepare(`SELECT n.*, s.name as source_name FROM nodes n LEFT JOIN sources s ON s.id=n.source_id WHERE COALESCE(s.enabled,1)=1 ORDER BY n.id DESC`).all()
  ]);
  const subs = await listSubscriptionsView(request, env);
  const subsJson = await subs.json();
  return json({ ok: true, sources: src.results || [], nodes: nodes.results || [], subscriptions: subsJson.subscriptions || [] });
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

async function checkConnectivityBatch(request, env) {
  const body = await safeJson(request);
  const sourceId = Number(body?.sourceId || 0);
  const limit = Math.max(1, Math.min(200, Number(body?.limit || 20)));
  let rows;
  if (sourceId > 0) {
    rows = (await env.DB.prepare(`
      SELECT n.id,n.source_id,n.node_hash,n.raw_link,n.node_name,s.source_type,s.panel_url,s.panel_token
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE COALESCE(n.enabled,1)=1 AND COALESCE(s.enabled,1)=1 AND n.source_id=?
      ORDER BY n.id DESC LIMIT ?
    `).bind(sourceId, limit).all()).results || [];
  } else {
    rows = (await env.DB.prepare(`
      SELECT n.id,n.source_id,n.node_hash,n.raw_link,n.node_name,s.source_type,s.panel_url,s.panel_token
      FROM nodes n LEFT JOIN sources s ON s.id=n.source_id
      WHERE COALESCE(n.enabled,1)=1 AND COALESCE(s.enabled,1)=1
      ORDER BY n.id DESC LIMIT ?
    `).bind(limit).all()).results || [];
  }
  await runConnectivityRows(rows, env);
  const out = (await env.DB.prepare(`
    SELECT n.id as node_id,c.status,c.latency_ms,c.last_error,c.checked_at
    FROM nodes n LEFT JOIN node_connectivity c ON c.node_id=n.id
    ${sourceId > 0 ? 'WHERE n.source_id=?' : ''}
    ORDER BY n.id DESC LIMIT ?
  `).bind(...(sourceId > 0 ? [sourceId, limit] : [limit])).all()).results || [];
  return json({ ok: true, checked: rows.length, items: out });
}

async function toggleNodeEnabled(path, env) {
  const m = path.match(/^\/api\/nodes\/(\d+)\/toggle$/);
  const id = Number(m?.[1] || 0);
  const old = await env.DB.prepare('SELECT id,enabled FROM nodes WHERE id=?').bind(id).first();
  if (!old) return json({ ok: false, error: 'node not found' }, 404);
  const next = Number(old.enabled || 0) ? 0 : 1;
  await env.DB.prepare('UPDATE nodes SET enabled=?, updated_at=? WHERE id=?').bind(next, now(), id).run();
  return json({ ok: true, enabled: next });
}

async function renameNode(path, request, env) {
  const m = path.match(/^\/api\/nodes\/(\d+)\/rename$/);
  const id = Number(m?.[1] || 0);
  const body = await safeJson(request);
  const node_name = String(body?.node_name || '').trim();
  if (!node_name) return json({ ok: false, error: 'node_name 必填' }, 400);
  const old = await env.DB.prepare('SELECT id FROM nodes WHERE id=?').bind(id).first();
  if (!old) return json({ ok: false, error: 'node not found' }, 404);
  await env.DB.prepare('UPDATE nodes SET node_name=?, updated_at=? WHERE id=?').bind(node_name, now(), id).run();
  return json({ ok: true });
}

async function ensureLocalSource(env) {
  const row = await env.DB.prepare("SELECT id FROM sources WHERE COALESCE(source_type,'sui_api')='local' LIMIT 1").first();
  if (row?.id) return Number(row.id);
  await env.DB.prepare(`INSERT INTO sources(name,panel_url,panel_token,source_type,enabled,created_at) VALUES('本地节点','local://nodes','', 'local',1,?)`).bind(now()).run();
  const n = await env.DB.prepare("SELECT id FROM sources WHERE COALESCE(source_type,'sui_api')='local' ORDER BY id DESC LIMIT 1").first();
  return Number(n?.id || 0);
}

async function addLocalNode(request, env) {
  const b = await safeJson(request);
  const raw = String(b?.raw_link || '').trim();
  const node_name = String(b?.node_name || '').trim();
  if (!raw) return json({ ok: false, error: 'raw_link 必填' }, 400);
  const source_id = await ensureLocalSource(env);
  const h = await sha256hex(raw);
  const name = node_name || decodeHashName(raw) || 'local-node';
  await env.DB.prepare(`
    INSERT INTO nodes(source_id,node_hash,node_name,raw_link,enabled,created_at,updated_at)
    VALUES(?,?,?,?,1,?,?)
    ON CONFLICT(source_id,node_hash) DO UPDATE SET node_name=excluded.node_name,raw_link=excluded.raw_link,updated_at=excluded.updated_at
  `).bind(source_id, h, name, raw, now(), now()).run();
  return json({ ok: true });
}

async function deleteLocalNode(path, env) {
  const m = path.match(/^\/api\/local-nodes\/(\d+)$/);
  const id = Number(m?.[1] || 0);
  const row = await env.DB.prepare('SELECT n.id,s.source_type FROM nodes n LEFT JOIN sources s ON s.id=n.source_id WHERE n.id=?').bind(id).first();
  if (!row) return json({ ok: false, error: 'node not found' }, 404);
  if (String(row.source_type || '') !== 'local') return json({ ok: false, error: 'only local node can be deleted here' }, 400);
  await env.DB.prepare('DELETE FROM node_connectivity WHERE node_id=?').bind(id).run();
  await env.DB.prepare('DELETE FROM nodes WHERE id=?').bind(id).run();
  return json({ ok: true });
}

async function getSourceById(env, sourceId) {
  return await env.DB.prepare('SELECT * FROM sources WHERE id=?').bind(sourceId).first();
}

async function suiRequest(source, path, { method = 'GET', body } = {}) {
  const base = String(source?.panel_url || '').replace(/\/$/, '');
  if (!base) throw new Error('source panel_url empty');
  const headers = { 'accept': 'application/json', 'x-panel-token': String(source?.panel_token || '') };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const resp = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!resp.ok) throw new Error(`${path} HTTP ${resp.status}`);
  return await resp.json().catch(() => ({}));
}

async function suiRequestTry(source, paths = [], options = {}) {
  let lastErr;
  for (const p of paths) {
    try {
      return await suiRequest(source, p, options);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('sui request failed');
}

function normalizeInbounds(obj) {
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj?.inbounds)) return obj.inbounds;
  if (Array.isArray(obj?.obj?.inbounds)) return obj.obj.inbounds;
  if (Array.isArray(obj?.obj)) return obj.obj;
  return [];
}

async function listSuiInbounds(path, env) {
  const m = path.match(/^\/api\/sui\/(\d+)\/inbounds$/);
  const sourceId = Number(m?.[1] || 0);
  const source = await getSourceById(env, sourceId);
  if (!source) return json({ ok: false, error: 'source not found' }, 404);
  if (String(source.source_type || 'sui_api') !== 'sui_api') return json({ ok: false, error: 'source is not sui_api' }, 400);
  const j = await suiRequestTry(source, ['/api/inbounds', '/api/panel/inbounds', '/api/system/inbounds']);
  return json({ ok: true, inbounds: normalizeInbounds(j) });
}

async function quickCreateSuiReality(path, request, env) {
  const m = path.match(/^\/api\/sui\/(\d+)\/reality-quick$/);
  const sourceId = Number(m?.[1] || 0);
  const source = await getSourceById(env, sourceId);
  if (!source) return json({ ok: false, error: 'source not found' }, 404);
  const body = await safeJson(request);
  const remark = String(body?.remark || '').trim() || `quick-${Date.now()}`;
  await suiRequestTry(source, ['/api/inbounds/reality-quick', '/api/inbounds/quick-reality', '/api/panel/inbounds/reality-quick'], { method: 'POST', body: { remark } });
  return json({ ok: true });
}

async function renameSuiInbound(path, request, env) {
  const m = path.match(/^\/api\/sui\/(\d+)\/inbounds\/(\d+)\/rename$/);
  const sourceId = Number(m?.[1] || 0);
  const inboundId = Number(m?.[2] || 0);
  const source = await getSourceById(env, sourceId);
  if (!source) return json({ ok: false, error: 'source not found' }, 404);
  const body = await safeJson(request);
  const remark = String(body?.remark || '').trim();
  if (!remark) return json({ ok: false, error: 'remark 必填' }, 400);
  await suiRequestTry(source, [`/api/inbounds/${inboundId}/remark`, `/api/inbounds/${inboundId}/rename`, `/api/panel/inbounds/${inboundId}/remark`], { method: 'PUT', body: { remark } });
  return json({ ok: true });
}

async function deleteSuiInbound(path, env) {
  const m = path.match(/^\/api\/sui\/(\d+)\/inbounds\/(\d+)$/);
  const sourceId = Number(m?.[1] || 0);
  const inboundId = Number(m?.[2] || 0);
  const source = await getSourceById(env, sourceId);
  if (!source) return json({ ok: false, error: 'source not found' }, 404);
  await suiRequestTry(source, [`/api/inbounds/${inboundId}`, `/api/panel/inbounds/${inboundId}`], { method: 'DELETE' });
  return json({ ok: true });
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
  if (mode === 'clash') {
    const yaml = await buildClashYamlFromLinks(nodes.map(n => String(n.raw_link || '').trim()).filter(Boolean), env);
    await recordSubscriptionLog(request, env, sub, 'clash-compat');
    return withCors(new Response(yaml, { headers: { 'content-type': 'text/yaml; charset=utf-8' } }));
  }
  await recordSubscriptionLog(request, env, sub, mode === 'plain' ? 'plain' : 'plain-base64');
  if (mode === 'plain') return withCors(new Response(plain, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  const encoded = btoa(unescape(encodeURIComponent(plain)));
  return withCors(new Response(encoded, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
}

async function runConnectivityNow(env, ctx) {
  ctx.waitUntil(runConnectivitySweep(env));
  return json({ ok: true, queued: true, connectivity_status: await getConnectivityStatus(env) });
}

async function getAdminSettings(env) {
  return await env.DB.prepare('SELECT * FROM admin_settings WHERE id=1').first();
}

async function registerAdmin(request, env) {
  const exists = await getAdminSettings(env);
  if (exists) return json({ ok: false, error: '管理员已存在，不可重复注册' }, 409);
  const body = await safeJson(request);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '');
  if (!username) return json({ ok: false, error: 'username 必填' }, 400);
  if (password.length < 6) return json({ ok: false, error: 'password 至少6位' }, 400);
  await env.DB.prepare('INSERT INTO admin_settings(id,username,password,auto_connectivity_ms,auto_connectivity_limit,updated_at) VALUES(1,?,?,600000,60,?)')
    .bind(username, password, now()).run();
  return json({ ok: true, username });
}

async function getConnectivityStatus(env) {
  const adm = await getAdminSettings(env);
  return {
    auto_connectivity_ms: Number(adm?.auto_connectivity_ms || 600000),
    auto_connectivity_limit: Number(adm?.auto_connectivity_limit || 60),
    running: 0,
    last_at: '',
    last_checked: 0,
    last_ok: 0,
    last_fail: 0,
    last_error: '',
    last_duration_ms: 0
  };
}

async function getAdminUser(env) {
  const adm = await getAdminSettings(env);
  if (!adm) return json({ ok: false, need_register: true }, 404);
  return json({
    ok: true,
    username: String(adm?.username || ''),
    auto_connectivity_ms: Number(adm?.auto_connectivity_ms || 600000),
    auto_connectivity_limit: Number(adm?.auto_connectivity_limit || 60),
    connectivity_status: await getConnectivityStatus(env)
  });
}

async function saveAdminUser(request, env) {
  const body = await safeJson(request);
  const username = String(body?.username || '').trim();
  const password = String(body?.password || '').trim();
  const autoMs = Math.max(60000, Number(body?.auto_connectivity_ms || 600000));
  const autoLimit = Math.max(1, Math.min(200, Number(body?.auto_connectivity_limit || 60)));
  if (!username) return json({ ok: false, error: 'username 必填' }, 400);
  const old = await getAdminSettings(env);
  if (!old) return json({ ok: false, error: '未注册管理员，请先注册' }, 400);
  const nextPass = password ? password : String(old?.password || '');
  await env.DB.prepare('UPDATE admin_settings SET username=?, password=?, auto_connectivity_ms=?, auto_connectivity_limit=?, updated_at=? WHERE id=1')
    .bind(username, nextPass, autoMs, autoLimit, now()).run();
  return json({ ok: true, connectivity_status: await getConnectivityStatus(env) });
}

async function listSubLogs(request, env) {
  const u = new URL(request.url);
  const limit = Math.max(1, Math.min(10, Number(u.searchParams.get('limit') || 10)));
  const rows = await env.DB.prepare(`
    SELECT id, token, subscription_id, subscription_name, route_type, client_ip, user_agent, device_hint, created_at
    FROM subscription_logs ORDER BY id DESC LIMIT ?
  `).bind(limit).all();
  return json({ ok: true, logs: rows.results || [] });
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
    `CREATE TABLE IF NOT EXISTS admin_settings (
      id INTEGER PRIMARY KEY CHECK (id=1),
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      auto_connectivity_ms INTEGER NOT NULL DEFAULT 600000,
      auto_connectivity_limit INTEGER NOT NULL DEFAULT 60,
      updated_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS subscription_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      subscription_id INTEGER,
      subscription_name TEXT,
      route_type TEXT NOT NULL,
      client_ip TEXT,
      user_agent TEXT,
      device_hint TEXT,
      created_at TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_nodes_source_id ON nodes(source_id);`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);`,
    `CREATE INDEX IF NOT EXISTS idx_connectivity_status ON node_connectivity(status);`
  ];

  for (const s of sqlList) {
    await env.DB.prepare(s).run();
  }

  return { message: 'schema initialized', tables: ['sources', 'nodes', 'subscriptions', 'node_connectivity', 'admin_settings', 'subscription_logs'] };
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

async function recordSubscriptionLog(request, env, sub, routeType) {
  try {
    const ua = String(request.headers.get('user-agent') || '');
    const ip = String(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    await env.DB.prepare(`
      INSERT INTO subscription_logs(token,subscription_id,subscription_name,route_type,client_ip,user_agent,device_hint,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).bind(
      String(sub?.token || ''),
      Number(sub?.id || 0) || null,
      String(sub?.name || ''),
      String(routeType || 'unknown'),
      ip,
      ua,
      'unknown',
      now()
    ).run();
    await env.DB.prepare('DELETE FROM subscription_logs WHERE id NOT IN (SELECT id FROM subscription_logs ORDER BY id DESC LIMIT 100)').run();
  } catch {}
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

function decodeHashName(raw = '') {
  const i = String(raw).indexOf('#');
  if (i < 0) return '';
  try { return decodeURIComponent(String(raw).slice(i + 1)).trim(); } catch { return String(raw).slice(i + 1).trim(); }
}

function escYaml(v = '') {
  return String(v || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseNodeNameFromLink(link = '', idx = 1) {
  const h = decodeHashName(link);
  if (h) return h;
  const m = String(link).match(/^(\w+):\/\//);
  return `${(m?.[1] || 'node').toUpperCase()}-${idx}`;
}

function toYamlList(items = []) {
  return (Array.isArray(items) ? items : []).map(x => `  - "${escYaml(x)}"`).join('\n');
}

function parseB64Loose(s=''){
  const t=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
  const pad=t.length%4===0?'':'='.repeat(4-(t.length%4));
  try{return atob(t+pad);}catch{return '';}
}

function parseLinkToProxyObj(raw = '', idx = 1) {
  const link = String(raw || '').trim();
  const name = parseNodeNameFromLink(link, idx);
  try {
    if (link.startsWith('ss://')) {
      const noScheme = link.slice(5).split('#')[0];
      const [authPart, hostPart] = noScheme.includes('@') ? noScheme.split('@') : [parseB64Loose(noScheme.split('?')[0]), noScheme.split('?')[0]];
      let cipher = 'aes-128-gcm', password = 'password', host='0.0.0.0', port=443;
      if (authPart && authPart.includes(':')) {
        const a = authPart.includes('@') ? authPart.split('@')[0] : authPart;
        const [c,p]=a.split(':'); cipher=c||cipher; password=p||password;
      }
      const hp = hostPart.includes('@') ? hostPart.split('@').pop() : hostPart;
      const hp2 = hp.split('?')[0];
      if (hp2.includes(':')) { const i = hp2.lastIndexOf(':'); host = hp2.slice(0,i) || host; port = Number(hp2.slice(i+1) || port); }
      return { name, type: 'ss', server: host, port, udp: true, cipher, password };
    }
    if (link.startsWith('trojan://')) {
      const u = new URL(link);
      return { name, type: 'trojan', server: u.hostname || '0.0.0.0', port: Number(u.port || 443), udp: true, password: decodeURIComponent(u.username || ''), sni: u.searchParams.get('sni') || undefined };
    }
    if (link.startsWith('vmess://')) {
      const payload = parseB64Loose(link.slice('vmess://'.length));
      const obj = JSON.parse(payload || '{}');
      return { name, type: 'vmess', server: obj.add || '0.0.0.0', port: Number(obj.port || 443), udp: true, uuid: obj.id || '00000000-0000-0000-0000-000000000000', alterId: Number(obj.aid || 0), cipher: obj.scy || 'auto', network: obj.net || undefined, tls: String(obj.tls||'').toLowerCase()==='tls', servername: obj.sni || obj.host || undefined };
    }
    if (link.startsWith('vless://')) {
      const u = new URL(link);
      return { name, type: 'vless', server: u.hostname || '0.0.0.0', port: Number(u.port || 443), udp: true, uuid: decodeURIComponent(u.username || ''), network: u.searchParams.get('type') || 'tcp', tls: (u.searchParams.get('security') || '').toLowerCase() === 'tls', servername: u.searchParams.get('sni') || undefined };
    }
    if (link.startsWith('hysteria2://') || link.startsWith('hy2://')) {
      const u = new URL(link.replace('hy2://', 'hysteria2://'));
      return { name, type: 'hysteria2', server: u.hostname || '0.0.0.0', port: Number(u.port || 443), udp: true, password: decodeURIComponent(u.username || ''), sni: u.searchParams.get('sni') || undefined };
    }
  } catch {}
  return { name, type: 'ss', server: '0.0.0.0', port: 443, udp: true, cipher: 'aes-128-gcm', password: 'password' };
}

function proxyObjToInlineYaml(p) {
  const order = ['name', 'type', 'server', 'port', 'udp', 'uuid', 'alterId', 'cipher', 'password', 'network', 'tls', 'servername', 'sni'];
  const arr = [];
  for (const k of order) {
    if (p[k] === undefined || p[k] === null || p[k] === '') continue;
    const v = p[k];
    if (typeof v === 'number') arr.push(`${k}: ${v}`);
    else if (typeof v === 'boolean') arr.push(`${k}: ${v ? 'true' : 'false'}`);
    else arr.push(`${k}: "${escYaml(String(v))}"`);
  }
  return `  - { ${arr.join(', ')} }`;
}

async function buildClashYamlFromLinks(links = [], env) {
  const list = (Array.isArray(links) ? links : []).filter(Boolean);
  const names = list.map((link, i) => parseNodeNameFromLink(link, i + 1));

  const templateUrl = String(env?.CLASH_TEMPLATE_URL || 'https://raw.githubusercontent.com/Spittingjiu/mihomo-generic-template/main/clash-template.yaml').trim();
  const tplResp = await fetch(templateUrl, { headers: { 'accept': 'application/yaml,text/yaml,text/plain,*/*', 'cache-control': 'no-cache' } });
  if (!tplResp.ok) throw new Error(`template fetch failed: HTTP ${tplResp.status}`);
  let yaml = await tplResp.text();

  yaml = yaml.replace(/\r\n/g, '\n');

  const manualBlock = `  - name: 手动选择\n    type: select\n    include-all: true\n    proxies:\n${toYamlList(names)}\n    exclude-filter: "^(?i:(DIRECT|REJECT|PASS))$"`;
  yaml = yaml.replace(/(^\s*-\s*name:\s*手动选择[\s\S]*?exclude-filter:\s*"\^\(\?i:\(DIRECT\|REJECT\|PASS\)\)\$"\s*)/m, manualBlock + '\n');

  const autoBlock = `  - name: 自动选择\n    type: url-test\n    include-all: true\n    proxies:\n${toYamlList(names)}\n    url: https://cp.cloudflare.com/generate_204\n    interval: 600\n    tolerance: 100\n    exclude-filter: "^(?i:(DIRECT|REJECT|PASS))$"`;
  yaml = yaml.replace(/(^\s*-\s*name:\s*自动选择[\s\S]*?exclude-filter:\s*"\^\(\?i:\(DIRECT\|REJECT\|PASS\)\)\$"\s*)/m, autoBlock + '\n');

  const proxiesBlock = ['proxies:', ...list.map((raw, i) => proxyObjToInlineYaml(parseLinkToProxyObj(raw, i + 1)))].join('\n');
  yaml = yaml.replace(/^proxies:[\s\S]*?\nproxy-groups:/m, `${proxiesBlock}\nproxy-groups:`);

  return yaml;
}

function jsonParse(s, fallback) {
  try { return JSON.parse(String(s || '')); } catch { return fallback; }
}

async function sha256hex(input = '') {
  const data = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0, viewport-fit=cover"/>
  <title>sub订阅分发平台</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root{--bg:#0b1020;--bg2:#0f1730;--card:#121933;--line:#263258;--line2:#36446f;--txt:#eef2ff;--muted:rgba(238,242,255,.72);--ok:#7ef8a5;--err:#ff8f8f;--card-grad1:#121933;--card-grad2:#0f1730;--src-bg:#0d1530;--src-line:#2b3963;--modal-grad1:#161f43;--modal-grad2:#101834;--capsule-bg:#f8fbff;--capsule-fg:#121a33;--capsule-border:#e8efff}
    *{box-sizing:border-box}
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;margin:0;background:var(--bg);color:var(--txt);line-height:1.45;transition:background .2s,color .2s}
    body.auth-mode{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:18px}
    .wrap{max-width:1160px;margin:20px auto;padding:0 14px}
    .card{background:linear-gradient(180deg,var(--card-grad1),var(--card-grad2));border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
    input,button,select{border-radius:10px;border:1px solid var(--line2);background:var(--bg2);color:var(--txt);padding:10px}
    input, textarea, select { font-size:16px !important; }
    input{width:100%;min-width:0;outline:none}
    button{cursor:pointer;white-space:nowrap;transition:.2s transform,.2s border-color,.2s background}
    button:hover{border-color:#6f7df6;transform:translateY(-1px)}
    .grid{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px}
    .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .muted{color:var(--muted);font-size:13px}
    .ok{color:var(--ok)} .err{color:var(--err)} .hide{display:none}
    .pill{padding:3px 8px;border-radius:999px;background:var(--capsule-bg);color:var(--capsule-fg);border:1px solid var(--capsule-border);display:inline-block;font-size:12px;font-weight:600}
    table{width:100%;border-collapse:collapse;min-width:560px}
    td,th{border-bottom:1px solid #243055;padding:4px 2px;text-align:left;font-size:13px}
    #nodes table{min-width:520px}
    #nodes th:nth-child(1),#nodes td:nth-child(1){width:46px;padding-right:2px}
    #nodes th:nth-child(2),#nodes td:nth-child(2){width:82px;padding-left:2px;padding-right:2px}
    #nodes th:nth-child(3),#nodes td:nth-child(3){padding-left:2px;padding-right:4px;max-width:210px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #nodes th:nth-child(4),#nodes td:nth-child(4){width:92px;padding-left:4px;padding-right:4px;white-space:nowrap;text-align:left}
    #nodes th:nth-child(5),#nodes td:nth-child(5){width:64px;white-space:nowrap}
    #nodes th:nth-child(6),#nodes td:nth-child(6){width:170px;white-space:nowrap}
    .tab-on{background:linear-gradient(90deg,#3b82f6,#8b5cf6);border-color:#6f7df6;color:#fff}
    .chips{display:flex;gap:6px;flex-wrap:wrap}.chip{padding:4px 8px;max-width:280px;border-radius:999px;background:var(--capsule-bg);color:var(--capsule-fg);border:1px solid var(--capsule-border);font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sel-list{max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px;margin-top:8px}
    .src-item{padding:12px;border:1px solid var(--src-line);border-radius:12px;background:var(--src-bg);margin:8px 0}
    .src-item .row{row-gap:10px}
    #subs input[readonly]{max-width:320px;min-width:240px}
    #nodes,#suiNodes{overflow-x:auto}
    .modal-mask{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px;z-index:50}
    .modal-mask.hide{display:none!important}
    .modal-box{width:min(760px,96vw);max-height:88vh;overflow:auto;background:linear-gradient(180deg,var(--modal-grad1),var(--modal-grad2));border:1px solid #445189;border-radius:14px;padding:14px}
    #linkModal .modal-box{width:min(430px,95vw)}
    #linkQr{width:220px;height:220px;border-radius:10px;border:1px solid #2b3963;background:#fff;padding:8px;display:block;margin:8px auto}
    #loginCard{width:min(460px,94vw);padding:20px}

    body.theme-light{--bg:#f2f6ff;--bg2:#ffffff;--card:#ffffff;--line:#d8e2ff;--line2:#c5d4ff;--txt:#1b2440;--muted:rgba(27,36,64,.68);--ok:#16a34a;--err:#dc2626;--card-grad1:#ffffff;--card-grad2:#f7faff;--src-bg:#f8fbff;--src-line:#d5e1ff;--modal-grad1:#ffffff;--modal-grad2:#f7faff;--capsule-bg:#324576;--capsule-fg:#f7f9ff;--capsule-border:#6f85bd}
    body.theme-light .tab-on{color:#fff}

    .capsule-toggle{display:inline-flex;align-items:center;gap:8px;margin-top:8px;padding:6px 10px;border:1px solid var(--capsule-border);border-radius:999px;background:var(--capsule-bg);color:var(--capsule-fg);cursor:pointer;max-width:100%}
    .capsule-toggle input{width:15px;height:15px;flex:0 0 auto}
    .capsule-toggle-text{color:var(--capsule-fg);font-size:13px;line-height:1.35;white-space:normal;overflow:visible;text-overflow:clip}
    .modal-node-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .modal-node-item{background:#1c2b5a !important;border-color:#4e66a8 !important}
    body.theme-light .modal-node-item{background:#f7faff !important;border-color:#d7e3ff !important}


    .log-box{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--bg2)}

    @media (max-width:860px){
      .grid{grid-template-columns:1fr}
      .wrap{padding:0 10px}
      .card{padding:14px}
      .row{gap:6px}
      #subs input[readonly]{max-width:100%;min-width:0;width:100%}
      .chip{max-width:100%}
      .modal-node-grid{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div id="loginCard" class="card hide">
    <h2 style="margin:0 0 8px">🔐 登录 sub订阅分发平台</h2>
    <input id="lu" placeholder="用户名" autocomplete="username"/>
    <input id="lp" type="password" placeholder="密码" autocomplete="current-password" style="margin-top:8px"/>
    <button onclick="login()" style="margin-top:8px;width:100%">进入控制台</button>
    <button id="registerBtn" onclick="registerAdmin()" style="margin-top:8px;width:100%" class="hide">首次注册管理员</button>
    <div id="lmsg" class="muted" style="margin-top:8px"></div>
  </div>

  <div id="app" class="hide wrap">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <div class="row" style="gap:6px;margin-bottom:8px">
          <button id="tabHomeBtn" onclick="switchTab('home')">源</button>
          <button id="tabNodeBtn" onclick="switchTab('nodes')">节点&订阅</button>
          <button id="tabSuiBtn" onclick="switchTab('sui')">SUI管理</button>
          <button id="tabUserBtn" onclick="switchTab('user')">用户管理</button>
        </div>
        <h1 style="margin:0">🚀 sub订阅分发平台</h1>
      </div>
      <div class="row" style="gap:8px">
        <button id="themeBtn" onclick="toggleTheme()">浅色主题</button>
        <button onclick="logout()">退出登录</button>
      </div>
    </div>

    <div id="tab-home">
      <div class="card">
        <h3 style="margin:0">新增连接源</h3>

        <details style="border:1px solid var(--line);border-radius:12px;padding:8px 10px;background:var(--bg2);margin-top:10px">
          <summary style="cursor:pointer;user-select:none;font-weight:700">新建 SUI 源</summary>
          <div class="grid" style="margin-top:10px">
            <input id="suiName" placeholder="名称（例如：东京）"/>
            <input id="suiPanel" placeholder="面板地址（https://panel.example.com）"/>
            <input id="suiToken" placeholder="SUI API Token（或填 账号:密码）"/>
            <button onclick="addSource('sui')">保存</button>
          </div>
        </details>

        <details style="border:1px solid var(--line);border-radius:12px;padding:8px 10px;background:var(--bg2);margin-top:8px">
          <summary style="cursor:pointer;user-select:none;font-weight:700">新建 CF 源</summary>
          <div class="grid" style="margin-top:10px">
            <input id="cfName" placeholder="名称（例如：CF-订阅）"/>
            <input id="cfPanel" placeholder="CF 订阅链接（https://.../sub）"/>
            <input id="cfToken" placeholder="访问密钥（可选，不填可留空）"/>
            <button onclick="addSource('cf')">保存</button>
          </div>
        </details>

        <div id="msg" class="muted" style="margin-top:8px"></div>
      </div>
      <div class="card">
        <h3>连接源</h3>
        <div id="sources"></div>
      </div>
    </div>

    <div id="tab-nodes" class="hide">
      <div class="card">
        <h3>订阅链接（多个）</h3>
        <button onclick="openSubModal()">新建订阅</button>
        <div id="subs" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <h3>节点列表（按源查看）</h3>
        <div class="row" style="margin-top:6px">
          <select id="nodeSourceSelect" style="min-width:150px;max-width:190px" onchange="setNodeSource(this.value)"></select>
          <span id="kernelBadge" class="pill">测速内核：检测中…</span>
          <button id="kernelToggleBtn" onclick="toggleKernelInstall()">加载中…</button>
          <input id="localNodeLink" placeholder="粘贴节点链接" style="min-width:320px;max-width:640px;flex:1 1 520px"/>
          <input id="localNodeName" placeholder="备注(可选)" style="min-width:86px;max-width:120px;flex:0 0 110px"/>
          <button id="addLocalBtn" onclick="addLocalNode()" style="margin-left:auto">添加本地节点</button>
        </div>
        <div id="nodeMsg" class="muted" style="margin-top:6px"></div><div id="nodes" style="margin-top:6px;max-height:56vh;overflow:auto"></div>
      </div>
    </div>

    <div id="tab-sui" class="hide">
      <div class="card">
        <h3>SUI 节点管理</h3>
        <div class="row" style="margin-bottom:10px">
          <select id="suiSource" style="min-width:220px"></select>
          <input id="realityName" placeholder="Reality 节点名称（可自定义）" style="min-width:220px"/>
          <button onclick="loadSuiNodes()">刷新节点</button>
          <button onclick="quickReality()">一键 Reality</button>
        </div>
        <div id="suiNodes"></div>
      </div>
    </div>

    <div id="tab-user" class="hide">
      <div class="card">
        <h3>用户管理</h3>
        <div class="row">
          <input id="adminUser" placeholder="新用户名" style="max-width:240px"/>
          <input id="adminPass" type="password" placeholder="新密码（留空=不修改）" style="max-width:260px"/>
          <button onclick="saveAdminUser()">保存设置</button>
        </div>
      </div>
      <div class="card">
        <h3>连通性调度</h3>
        <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
          <div style="display:flex;flex-direction:column;gap:4px">
            <div class="muted" style="font-size:12px">扫描间隔（分钟）</div>
            <input id="autoConnectivityMin" type="number" min="1" max="1440" placeholder="连通性扫描间隔(分钟)" style="max-width:240px"/>
          </div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <div class="muted" style="font-size:12px">单次扫描节点上限</div>
            <input id="autoConnectivityLimit" type="number" min="1" max="200" placeholder="单次扫描节点上限" style="max-width:240px"/>
          </div>
          <button onclick="runConnectivityNow()">立即扫描一次</button>
        </div>
        <div id="connectivityStatus" class="muted" style="margin-top:8px">连通性状态：未加载</div>
      </div>
      <div class="card">
        <h3>订阅更新日志</h3>
        <div class="muted" style="margin-bottom:8px">自动刷新，最多保留最近 10 条：更新时间、来源IP、UA与设备识别</div>
        <div id="subLogs" class="log-box">暂无日志</div>
      </div>

    </div>
  </div>

  <div id="subModal" class="modal-mask hide">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between"><h3 id="subModalTitle" style="margin:0">编辑订阅</h3><button onclick="closeSubModal()">关闭</button></div>
      <div class="row" style="margin-top:10px">
        <input id="modalSubName" placeholder="订阅名称" style="max-width:320px"/>
        <select id="modalSourceFilter" style="min-width:220px"></select>
        <button onclick="saveSubModal()">保存</button>
      </div>
      <label for="modalAutoPrune" class="capsule-toggle">
        <input id="modalAutoPrune" type="checkbox">
        <span class="capsule-toggle-text">自动剔除不通节点（不改勾选）</span>
      </label>
      <div class="muted" style="margin-top:8px">先选源，再选该源的节点</div>
      <div id="modalPicked" class="chips" style="margin-top:6px"></div>
      <div id="modalNodeList" class="sel-list"></div>
    </div>
  </div>

  <div id="linkModal" class="modal-mask hide">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">订阅二维码</h3><button onclick="closeLinkModal()">关闭</button></div>
      <div class="row" style="gap:8px;margin:8px 0 2px">
        <button id="linkTabGeneral" class="tab-on" onclick="switchLinkTab('general')">通用版</button>
      </div>
      <img id="linkQr" alt="订阅二维码" />
      <input id="linkText" readonly />
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button onclick="copyFromModal()">复制链接</button>
        <button id="importGeneralBtn" onclick="openGeneralImportFromModal()">通用导入</button><button id="importBtn" onclick="openClashImportFromModal()">Clash导入</button>
      </div>
    </div>
  </div>

  <div id="cfFilterModal" class="modal-mask hide">
    <div class="modal-box">
      <div class="row" style="justify-content:space-between;align-items:center">
        <h3 id="cfFilterTitle" style="margin:0">CF 节点筛选</h3>
        <button onclick="closeCfFilterModal()">关闭</button>
      </div>
      <div id="cfFilterBody" style="margin-top:10px"></div>
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        <button onclick="clearCfFilterDraft()">清空勾选</button>
        <button onclick="applyCfFilter()">应用筛选</button>
      </div>
    </div>
  </div>

<script>
const q=s=>document.querySelector(s);
let sources=[], allNodes=[], modalAllNodes=[], sourceViewId='all', editingSubId=null;
let currentModalLinks={general:'',clash:''};
let currentModalClashImports={general:'',clash:''};
let currentModalGeneralImports={general:{v2rayn:'',v2rayng:''},clash:{v2rayn:'',v2rayng:''}};
let currentLinkTab='general';
let theme='dark';
let activeTab='home';
const selectedNodeIds=new Set();
let cfFilterSourceId=null;
let cfFilterDraft={};
// per-subscription persisted filter snapshots
// 结构：{ [subId|'new']: { [sourceId]: { transport:Set, hostType:Set, alpn:Set, tag:Set } } }
let subFilterState={};
const esc=(s)=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const isLocalSource=(s)=>String(s?.source_type||'sui_api')==='local' || String(s?.panel_url||'')==='local://manual';
const orderedSources=()=>[...sources].sort((a,b)=>{
  const al=isLocalSource(a), bl=isLocalSource(b);
  if(al!==bl) return al?-1:1;
  return Number(a.id||0)-Number(b.id||0);
});
const toast=(t,c='')=>{const el=q('#msg');if(el){el.className=c;el.textContent=t;}};
async function api(url,opt={}){const method=String(opt?.method||'GET').toUpperCase();const h={'content-type':'application/json',...(opt?.headers||{})};if(!['GET','HEAD','OPTIONS'].includes(method))h['x-requested-with']='XMLHttpRequest';const r=await fetch(url,{...opt,headers:h});const j=await r.json().catch(()=>({ok:false,error:'响应异常'}));if(!j.ok) throw new Error(j.error||'请求失败');return j;}
function setAuthMode(v){document.body.classList.toggle('auth-mode',v)}
function updateThemeButton(){
  const btn=q('#themeBtn');
  if(!btn) return;
  btn.textContent = theme === 'light' ? '深色主题' : '浅色主题';
}
function applyTheme(next='dark'){
  theme = (next === 'light') ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', theme === 'light');
  updateThemeButton();
  try{ localStorage.setItem('sui_sub_theme', theme); }catch(_e){}
}
function toggleTheme(){
  applyTheme(theme === 'light' ? 'dark' : 'light');
}

function switchTab(tab){
  activeTab=tab;
  try{ localStorage.setItem('sui_sub_last_tab', tab); }catch(_e){}
  q('#tab-home').classList.toggle('hide',tab!=='home'); q('#tab-nodes').classList.toggle('hide',tab!=='nodes'); q('#tab-sui').classList.toggle('hide',tab!=='sui'); q('#tab-user').classList.toggle('hide',tab!=='user');
  q('#tabHomeBtn').classList.toggle('tab-on',tab==='home'); q('#tabNodeBtn').classList.toggle('tab-on',tab==='nodes'); q('#tabSuiBtn').classList.toggle('tab-on',tab==='sui'); q('#tabUserBtn').classList.toggle('tab-on',tab==='user');
  ['#kernelBadge','#kernelToggleBtn'].forEach(sel=>{const el=q(sel); if(el) el.style.display=(tab==='nodes')?'':'none';});
  if(tab==='sui') loadSuiNodes(); if(tab==='user') loadAdminUser();
}

async function checkAuth(){
  const me=await fetch('/api/auth/me');
  if(me.status===200){q('#loginCard').classList.add('hide');q('#app').classList.remove('hide');setAuthMode(false);init();return;}
  q('#loginCard').classList.remove('hide');q('#app').classList.add('hide');setAuthMode(true);
  try{
    const st=await api('/api/auth/status');
    const need=!!st.need_register;
    q('#registerBtn')?.classList.toggle('hide',!need);
    q('#lmsg').textContent=need?'首次使用请先注册管理员账号（用户名+密码）':'';
  }catch(_e){}
}
async function login(){try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:q('#lu').value.trim(),password:q('#lp').value})});q('#lmsg').textContent='';checkAuth();}catch(e){q('#lmsg').textContent=e.message;}}
async function registerAdmin(){try{await api('/api/auth/register',{method:'POST',body:JSON.stringify({username:q('#lu').value.trim(),password:q('#lp').value})});q('#lmsg').textContent='注册成功，请直接登录';q('#registerBtn')?.classList.add('hide');}catch(e){q('#lmsg').textContent=e.message;}}
async function logout(){await api('/api/auth/logout',{method:'POST',body:'{}'});location.reload();}

async function addSource(kind='sui'){
  try{
    const k=String(kind||'sui').toLowerCase()==='cf'?'cf':'sui';
    const name=q(k==='cf'?'#cfName':'#suiName').value.trim();
    const panel_url=q(k==='cf'?'#cfPanel':'#suiPanel').value.trim();
    const panel_token=q(k==='cf'?'#cfToken':'#suiToken').value.trim();
    await api('/api/sources',{method:'POST',body:JSON.stringify({name,panel_url,panel_token,source_type:(k==='cf'?'cf_sub':'sui_api')})});
    q(k==='cf'?'#cfName':'#suiName').value='';
    q(k==='cf'?'#cfPanel':'#suiPanel').value='';
    q(k==='cf'?'#cfToken':'#suiToken').value='';
    toast('已保存，自动同步中…','ok');
    await refreshAll();
  }catch(e){toast(e.message,'err')}
}
async function editSourceName(id){
  const oldName=(sources.find(x=>Number(x.id)===Number(id))||{}).name||'';
  const name=(prompt('请输入新的源名称：',oldName)||'').trim();
  if(!name || name===oldName) return;
  await api('/api/sources/'+id,{method:'PUT',body:JSON.stringify({name})});
  toast('源名称已更新','ok');
  await refreshAll();
}
async function toggleSourceEnabled(id){
  const s=(sources||[]).find(x=>Number(x.id)===Number(id));
  if(!s) return;
  const next=Number(s.enabled??1)?0:1;
  await api('/api/sources/'+id,{method:'PUT',body:JSON.stringify({enabled:next})});
  toast(next?'源已启用':'源已停用','ok');
  await refreshAll();
  await loadNodes();
}
async function deleteSource(id){if(!confirm('确认删除该源？'))return;await api('/api/sources/'+id,{method:'DELETE'});await refreshAll();}

function simplifySourceSyncStatus(raw=''){
  const t=String(raw||'').trim();
  if(!t) return '未同步';
  const l=t.toLowerCase();
  if(l==='ok') return '同步成功';
  if(l==='pending') return '等待同步';
  if(l==='local') return '本地源';

  // 常见错误归一成简洁中文
  if(/etimedout|connect timeout|timeout/.test(l)) return '连接超时，请检查面板地址/网络';
  if(/econnrefused/.test(l)) return '连接被拒绝，请检查端口/服务是否启动';
  if(/enotfound|getaddrinfo/.test(l)) return '域名解析失败，请检查域名配置';
  if(/self[- ]signed|certificate|tls/.test(l)) return '证书或TLS握手异常';
  if(/http\\s*401|unauthorized/.test(l)) return '鉴权失败（Token无效或已过期）';
  if(/http\\s*403|forbidden/.test(l)) return '无权限访问该面板';
  if(/http\\s*404/.test(l)) return '接口地址不存在（404）';
  if(/http\\s*5\\d\\d/.test(l)) return '面板服务异常（5xx）';
  if(/fetch failed|socket hang up|ehostunreach|enetunreach/.test(l)) return '网络不可达，请检查服务器连通性';

  if(l.startsWith('error:')) return '同步失败，请检查源配置';
  return t.length>42?\`\${t.slice(0,42)}…\`:t;
}

function sourceSyncText(s){
  if(isLocalSource(s)) return '';
  if(!s.last_sync_at) return '未同步';
  return \`\${simplifySourceSyncStatus(s.last_sync_status||'')} · \${new Date(s.last_sync_at).toLocaleString()}\`;
}
function isCfSource(s){
  const type=String(s?.source_type||'').toLowerCase();
  if(type.includes('cf') || type.includes('cloudflare')) return true;
  const panel=String(s?.panel_url||'').toLowerCase();
  const name=String(s?.name||'').toLowerCase();
  return /(workers\\.dev|cloudflare)/.test(panel) || /(^|[^a-z])cf([^a-z]|$)|cloudflare/.test(name);
}
function renderSourceCard(s){
  const isCf=isCfSource(s);
  const isLocal=isLocalSource(s);
  const enabled=Number(s?.enabled??1)?1:0;
  const sid=Number(s?.id||0);
  const toggleBtn=isLocal?'':\`<button onclick="toggleSourceEnabled(\${sid})">\${enabled?'停用':'启用'}</button>\`;
  const statusTag=isLocal?'':(enabled?'<span class="ok">已启用</span>':'<span class="err">已停用</span>');
  const nm=esc(s?.name||'');
  const panel=esc(s?.panel_url||'');
  const sync=esc(sourceSyncText(s)||'');
  return \`<div class="src-item" style="opacity:\${enabled?1:.65}"><div class="row" style="justify-content:space-between"><div><b>\${nm}</b><div class="muted">\${panel}</div></div><div class="row">\${statusTag}\${sync?\`<span class="pill">\${sync}</span>\`:''}<button onclick="focusSource(\${sid})">看节点</button>\${isLocal?'':(isCf?\`<button onclick="openCfFilterModal(\${sid})">节点筛选</button>\`:\`<button onclick="openSecurePanel(\${sid})">安全访问</button>\`)+toggleBtn+\`<button onclick="editSourceName(\${sid})">改名</button><button onclick="deleteSource(\${sid})">删除</button>\`}</div></div></div>\`;
}
function renderSourceGroup(title, list, open=true){
  return \`<details \${open?'open':''} style="border:1px solid var(--line);border-radius:12px;padding:8px 10px;background:var(--bg2);margin-top:8px"><summary style="cursor:pointer;user-select:none;font-weight:700">\${title}（\${list.length}）</summary><div style="margin-top:8px">\${list.length?list.map(renderSourceCard).join(''):'<div class="muted">暂无</div>'}</div></details>\`;
}
function renderSourcesUI(){
  const box=q('#sources');
  if(!sources.length){box.innerHTML='<div class="muted">暂无</div>';loadSuiSourceOptions(); renderNodeSourceSelect(); renderModalSourceFilter(); return;}
  const ordered=orderedSources();
  const cfSources=ordered.filter(s=>isCfSource(s));
  const suiSources=ordered.filter(s=>!isCfSource(s));
  box.innerHTML=\`\${renderSourceGroup('SUI源',suiSources,false)}\${renderSourceGroup('CF源',cfSources,false)}\`;
  loadSuiSourceOptions(); renderNodeSourceSelect(); renderModalSourceFilter();
}
function focusSource(id){sourceViewId=String(id);switchTab('nodes');renderNodeSourceSelect();renderNodes();}
function openSecurePanel(id){
  const sid=Number(id)||0;
  if(!sid) return;
  window.open(\`/panel-proxy/\${sid}/\`, '_blank', 'noopener');
}

function parseNodeMeta(n){
  const raw=String(n?.raw_link||'').trim();
  const name=String(n?.node_name||'');
  let transport='other', hostType='domain', host='', alpn='';
  try{
    const u=new URL(raw);
    host=(u.hostname||'').trim();
    // 标准判定：纯 IPv4 / 含冒号即 IPv6 / 其余视为域名
    if(/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(host)) hostType='ipv4';
    else if(host.includes(':')) hostType='ipv6';
    else hostType='domain';
    transport=(u.searchParams.get('type')||'').toLowerCase()||'other';
    alpn=(u.searchParams.get('alpn')||'').toLowerCase();
  }catch(_e){}
  // 回退保护：避免异常情况下 hostType 误判导致筛选放行
  if(hostType!=='ipv4' && hostType!=='ipv6' && hostType!=='domain') hostType='domain';
  const nn=name.toUpperCase();
  const tags=[];
  if(/移动/.test(name)) tags.push('移动');
  if(/联通/.test(name)) tags.push('联通');
  if(/电信/.test(name)) tags.push('电信');
  if(/HKG/.test(nn)) tags.push('HKG');
  if(/SJC/.test(nn)) tags.push('SJC');
  if(/SIN/.test(nn)) tags.push('SIN');
  if(/NRT/.test(nn)) tags.push('NRT');
  if(/LAX/.test(nn)) tags.push('LAX');
  if(/SEA/.test(nn)) tags.push('SEA');
  if(/MAA/.test(nn)) tags.push('MAA');
  if(/原生地址/.test(name)) tags.push('原生地址');
  return {transport,hostType,host,alpn,tags};
}

function buildCfFilters(nodes){
  const count=(arr,key)=>arr.reduce((m,x)=>{m[x[key]]=(m[x[key]]||0)+1;return m;},{});
  const metas=nodes.map(parseNodeMeta);
  const transports=count(metas,'transport');
  const hostTypes=count(metas,'hostType');
  const alpns={h3:0,h2:0};
  for(const m of metas){ if((m.alpn||'').includes('h3')) alpns.h3++; if((m.alpn||'').includes('h2')) alpns.h2++; }
  const tags=['移动','联通','电信','HKG','SJC','SIN','NRT','LAX','SEA','MAA','原生地址'];
  const tagCounts={};
  for(const t of tags) tagCounts[t]=metas.filter(x=>x.tags.includes(t)).length;
  return {metas,transports,hostTypes,alpns,tagCounts};
}

function optionCheckbox(name,label,count,checked=false){
  return \`<label style="display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);padding:6px 10px;border-radius:10px;background:var(--bg2)"><input type="checkbox" data-cf-key="\${esc(name)}" \${checked?'checked':''}/> \${label} <span class="muted">(\${count})</span></label>\`;
}

async function openCfFilterModal(sourceId){
  const sid=Number(sourceId)||0;
  if(!sid) return;
  cfFilterSourceId=sid;
  const src=sources.find(s=>Number(s.id)===sid);
  q('#cfFilterTitle').textContent=\`CF 节点筛选 · \${src?.name||sid}\`;
  const j=await api('/api/view/nodes?sourceId='+sid);
  const nodes=j.nodes||[];
  const f=buildCfFilters(nodes);
  const draft=cfFilterDraft[String(sid)]||{transport:new Set(),hostType:new Set(),alpn:new Set(),tag:new Set()};
  const isOn=(grp,key)=>draft[grp]&&draft[grp].has(key);
  const body=q('#cfFilterBody');
  body.innerHTML=\`
    <div class="muted" style="margin-bottom:8px">实时节点数：\${nodes.length}</div>
    <div style="margin:8px 0"><b>传输层</b><div class="row" style="margin-top:6px">\${['ws','xhttp','other'].map(k=>optionCheckbox(\`transport:\${k}\`,k.toUpperCase(),Number(f.transports[k]||0),isOn('transport',k))).join('')}</div></div>
    <div style="margin:8px 0"><b>地址类型</b><div class="row" style="margin-top:6px">\${['domain','ipv4','ipv6'].map(k=>optionCheckbox(\`hostType:\${k}\`,k,Number(f.hostTypes[k]||0),isOn('hostType',k))).join('')}</div></div>
    <div style="margin:8px 0"><b>ALPN</b><div class="row" style="margin-top:6px">\${['h3','h2'].map(k=>optionCheckbox(\`alpn:\${k}\`,k.toUpperCase(),Number(f.alpns[k]||0),isOn('alpn',k))).join('')}</div></div>
    <div style="margin:8px 0"><b>标签画像</b><div class="row" style="margin-top:6px">\${Object.keys(f.tagCounts).map(k=>optionCheckbox(\`tag:\${k}\`,k,Number(f.tagCounts[k]||0),isOn('tag',k))).join('')}</div></div>
  \`;
  q('#cfFilterModal').classList.remove('hide');
}

function closeCfFilterModal(){ q('#cfFilterModal').classList.add('hide'); }

function clearCfFilterDraft(){
  if(!cfFilterSourceId) return;
  const sid=String(cfFilterSourceId);
  cfFilterDraft[sid]={transport:new Set(),hostType:new Set(),alpn:new Set(),tag:new Set()};
  if(editingSubId){
    const key=String(editingSubId||'new');
    if(!subFilterState[key]) subFilterState[key]={};
    subFilterState[key][sid]={transport:new Set(),hostType:new Set(),alpn:new Set(),tag:new Set()};
  }
  openCfFilterModal(cfFilterSourceId);
}

function applyCfFilter(){
  if(!cfFilterSourceId) return;
  const sid=String(cfFilterSourceId);
  const next={transport:new Set(),hostType:new Set(),alpn:new Set(),tag:new Set()};
  document.querySelectorAll('#cfFilterBody input[data-cf-key]').forEach(el=>{
    if(!el.checked) return;
    const [grp,key]=String(el.getAttribute('data-cf-key')||'').split(':');
    if(next[grp]&&key) next[grp].add(key);
  });
  cfFilterDraft[sid]=next;
  if(editingSubId){
    const key=String(editingSubId||'new');
    if(!subFilterState[key]) subFilterState[key]={};
    subFilterState[key][sid]=next;
  }
  closeCfFilterModal();
  // 不管当前在“全部源”还是单源，都立即重算数量与列表
  renderNodeSourceSelect();
  renderNodes();
  // 若订阅编辑弹窗正在打开，也要同步刷新可选节点，并剔除筛选外已选项
  const subModal=q('#subModal');
  if(subModal && !subModal.classList.contains('hide')){
    pruneSelectedByCfFilter();
    renderSubModal();
  }
}

function passCfFilter(node){
  const sid=String(node?.source_id||'');
  const src=(sources||[]).find(s=>String(s.id)===sid);
  // 非 CF 源不应用 CF 筛选
  if(!isCfSource(src||{})) return true;
  const d=cfFilterDraft[sid];
  if(!d) return true;
  const hasAny=[...Object.values(d)].some(s=>s&&s.size>0);
  if(!hasAny) return true;
  const m=parseNodeMeta(node);
  if(d.transport?.size && !d.transport.has(m.transport)) return false;
  if(d.hostType?.size && !d.hostType.has(m.hostType)) return false;
  if(d.alpn?.size){
    const ok=[...d.alpn].some(k=>(m.alpn||'').includes(k));
    if(!ok) return false;
  }
  if(d.tag?.size){
    const ok=[...d.tag].some(k=>m.tags.includes(k));
    if(!ok) return false;
  }
  return true;
}

let kernelInstalled=false;
async function refreshKernelStatus(){
  try{
    const j=await api('/api/kernel/status');
    kernelInstalled=!!j.installed;
    const b=q('#kernelBadge'), btn=q('#kernelToggleBtn');
    if(b) b.textContent=\`测速内核：\${kernelInstalled?'已安装':'未安装'}\`;
    if(btn) btn.textContent=kernelInstalled?'卸载内核':'安装内核';
  }catch(e){
    const b=q('#kernelBadge'), btn=q('#kernelToggleBtn');
    if(b) b.textContent='测速内核：状态异常';
    if(btn) btn.textContent='重试检测';
  }
}
async function toggleKernelInstall(){
  try{
    const btn=q('#kernelToggleBtn'); if(btn) btn.disabled=true;
    if(kernelInstalled){
      await api('/api/kernel/uninstall',{method:'POST',body:'{}'});
      toast('测速内核已卸载','ok');
    }else{
      await api('/api/kernel/install',{method:'POST',body:'{}'});
      toast('测速内核已安装','ok');
    }
  }catch(e){
    const nm=q('#nodeMsg'); if(nm){nm.className='err'; nm.textContent=e.message;}
  }finally{
    const btn=q('#kernelToggleBtn'); if(btn) btn.disabled=false;
    await refreshKernelStatus();
  }
}

async function loadNodes(){const sid=(sourceViewId==='all'?0:Number(sourceViewId)||0);const pageY=window.scrollY||0;const box=q('#nodes');const st=box?box.scrollTop:0;const j=await api('/api/view/nodes'+(sid?\`?sourceId=\${sid}\`:''));allNodes=j.nodes||[];renderNodes();const box2=q('#nodes');if(box2) box2.scrollTop=st;if(activeTab==='nodes') window.scrollTo(0,pageY);}
function getLocalSourceId(){
  const src=sources.find(s=>isLocalSource(s));
  return src?String(src.id):'';
}
function setLocalAddVisible(){
  const localId=getLocalSourceId();
  const onLocal = localId && String(sourceViewId)===localId;
  ['#localNodeLink','#localNodeName','#addLocalBtn'].forEach(sel=>{const el=q(sel); if(el) el.style.display=onLocal?'':'none';});
}
function renderNodeSourceSelect(){
  const sel=q('#nodeSourceSelect'); if(!sel) return;
  const filteredRows=(allNodes||[]).filter(n=>passCfFilter(n));
  const filteredCountBySource=new Map();
  for(const n of filteredRows){
    const sid=Number(n.source_id||0);
    if(!sid) continue;
    filteredCountBySource.set(sid, Number(filteredCountBySource.get(sid)||0)+1);
  }

  const enabledSources=(sources||[]).filter(s=>Number(s?.enabled??1)===1);
  const local = enabledSources.find(s=>String(s.source_type||'sui_api')==='local' || String(s.panel_url||'')==='local://manual');
  const nonLocal = enabledSources.filter(s=>!(String(s.source_type||'sui_api')==='local' || String(s.panel_url||'')==='local://manual'));

  const sourceItems=[];
  if(local){
    sourceItems.push({ id:String(local.id), label:'本地节点', count:Number(local.node_count||0) });
  }
  for(const s of nonLocal){
    const isCf=isCfSource(s);
    const c=isCf?Number(filteredCountBySource.get(Number(s.id))||0):Number(s.node_count||0);
    sourceItems.push({ id:String(s.id), label:esc(s.name||''), count:c });
  }
  const total=sourceItems.reduce((a,x)=>a+Number(x.count||0),0);

  const options=[\`<option value=\\"all\\">全部源（\${total}）</option>\`, ...sourceItems.map(x=>\`<option value=\\"\${x.id}\\">\${x.label}（\${x.count}）</option>\`)];

  sel.innerHTML=options.join('');
  const has=[...sel.options].some(o=>o.value===String(sourceViewId));
  sel.value=has?String(sourceViewId):'all';
  if(!has) sourceViewId='all';
  setLocalAddVisible();
}
function setNodeSource(v){sourceViewId=String(v);renderNodeSourceSelect();setLocalAddVisible();const nm=q('#nodeMsg'); if(nm) nm.textContent='';loadNodes();}
function connectivityCell(n){
  const st=String(n.connectivity_status||'unknown');
  if(st==='ok') return \`<span class="ok">可用</span>\`;
  if(st==='testing') return \`<span class="pill">检测中</span>\`;
  if(st==='disconnected' || st==='fail') return \`<span class="err" title="\${esc(n.connectivity_last_error||'')}">不可用</span>\`;
  return \`<span class="muted">未检测</span>\`;
}
function renderNodes(){
  const rows=(allNodes||[]).filter(n=>passCfFilter(n)), box=q('#nodes');
  if(!rows.length){box.innerHTML='<div class="muted">该源暂无节点（或被筛选条件过滤）</div>';return;}
  box.innerHTML=\`<table><thead><tr><th>ID</th><th>来源</th><th>节点名</th><th><button onclick="checkConnectivity()" title="点击检测当前列表连通性" style="padding:4px 8px">连通性</button></th><th>状态</th><th>操作</th></tr></thead><tbody>\${rows.map(n=>{
    const id=Number(n.id||0);
    const isLocal=String(n.source_type||'sui_api')==='local';
    const op=isLocal
      ? \`<button onclick="toggleNode(\${id})">切换</button> <button onclick="renameNode(\${id})">改名</button> <button onclick="deleteLocalNode(\${id})">删除</button>\`
      : \`<button onclick="toggleNode(\${id})">切换</button> <button onclick="renameNode(\${id})">改名</button>\`;
    return \`<tr><td>\${id}</td><td>\${esc(n.source_name||n.source_id)}</td><td>\${esc(n.node_name||'')}</td><td>\${connectivityCell(n)}</td><td>\${n.enabled?'<span class="ok">启用</span>':'<span class="err">禁用</span>'}</td><td>\${op}</td></tr>\`;
  }).join('')}</tbody></table>\`;
}
let checkingConnectivity=false;
async function checkConnectivity(){
  if(checkingConnectivity) return;
  const nm=q('#nodeMsg');
  try{
    checkingConnectivity=true;
    const sourceId=(sourceViewId==='all'?0:Number(sourceViewId)||0);
    if(nm){nm.textContent='';}
    await api('/api/nodes/connectivity/check',{method:'POST',body:JSON.stringify({sourceId,limit:20})});
    await loadNodes();
    if(nm){nm.textContent='';}
  }catch(e){
    if(nm){nm.className='err'; nm.textContent=e.message;}
  }finally{
    checkingConnectivity=false;
  }
}
async function toggleNode(id){await api('/api/nodes/'+id+'/toggle',{method:'POST'});await loadNodes();}
async function addLocalNode(){
  const raw=(q('#localNodeLink')?.value||'').trim();
  const node_name=(q('#localNodeName')?.value||'').trim();
  if(!raw) return toast('请先粘贴节点链接','err');
  await api('/api/local-nodes',{method:'POST',body:JSON.stringify({raw_link:raw,node_name})});
  if(q('#localNodeLink')) q('#localNodeLink').value='';
  if(q('#localNodeName')) q('#localNodeName').value='';
  toast('已添加到本地节点','ok');
  await refreshAll();
  await loadNodes();
}
async function renameNode(id){
  const n=(allNodes||[]).find(x=>Number(x.id)===Number(id));
  const old=(n?.node_name||'').trim();
  const node_name=prompt('输入新节点名：', old);
  if(node_name===null) return;
  const name=String(node_name||'').trim();
  if(!name) return toast('节点名不能为空','err');
  await api('/api/nodes/'+id+'/rename',{method:'PUT',body:JSON.stringify({node_name:name})});
  toast('节点名已同步更新','ok');
  await refreshAll();
  await loadNodes();
}

async function deleteLocalNode(id){
  if(!confirm('确认删除该本地节点？')) return;
  await api('/api/local-nodes/'+id,{method:'DELETE'});
  toast('本地节点已删除','ok');
  await refreshAll();
  await loadNodes();
}

function renderLinkModal(){
  const mode=(currentLinkTab==='clash')?'clash':'general';
  const link=String(currentModalLinks[mode]||'').trim();
  const textEl=q('#linkText');
  const qrEl=q('#linkQr');
  if(textEl) textEl.value=link;
  if(qrEl) qrEl.src=\`https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=\${encodeURIComponent(link)}\`;
  const tab=q('#linkTabGeneral');
  if(tab){ tab.classList.toggle('tab-on',true); tab.textContent = mode==='clash' ? 'Clash版' : '通用版'; }
  const importBtn=q('#importBtn');
  const generalBtn=q('#importGeneralBtn');
  if(importBtn){ importBtn.textContent='Clash导入'; importBtn.style.display=(mode==='clash')?'':'none'; }
  if(generalBtn){ generalBtn.textContent='通用导入'; generalBtn.style.display=(mode==='general')?'':'none'; }
}
function switchLinkTab(mode){
  currentLinkTab=(mode==='clash')?'clash':'general';
  renderLinkModal();
}
function openLinkModal(link, clashImportUri='', generalImportUris={}, openMode='general'){
  const mode=(openMode==='clash')?'clash':'general';
  currentModalLinks={ general:'', clash:'' };
  currentModalLinks[mode]=String(link||'');
  currentModalClashImports={ general:String(clashImportUri||''), clash:String(clashImportUri||'') };
  currentModalGeneralImports={
    general:{ v2rayn:String(generalImportUris.v2rayn||''), v2rayng:String(generalImportUris.v2rayng||'') },
    clash:{ v2rayn:String(generalImportUris.v2rayn||''), v2rayng:String(generalImportUris.v2rayng||'') }
  };
  currentLinkTab=mode;
  renderLinkModal();
  q('#linkModal')?.classList.remove('hide');
}
function closeLinkModal(){ q('#linkModal')?.classList.add('hide'); }
async function copyFromModal(){
  const mode=(currentLinkTab==='clash')?'clash':'general';
  const txt=String(currentModalLinks[mode]||'').trim();
  if(!txt) return toast('没有可复制的链接','err');
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(txt);
    }else{
      const ta=document.createElement('textarea');
      ta.value=txt;
      ta.style.position='fixed';
      ta.style.left='-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(mode==='clash'?'已复制Clash链接':'已复制通用链接','ok');
  }catch(e){
    toast('复制失败，请手动复制','err');
  }
}
function openClashImportFromModal(){
  const mode=(currentLinkTab==='clash')?'clash':'general';
  const uri=String(currentModalClashImports[mode]||'');
  if(!uri){ toast('当前链接不支持 Clash 导入','err'); return; }
  location.href=uri;
}

function openGeneralImportFromModal(){
  const u=(navigator.userAgent||'').toLowerCase();
  const mode=(currentLinkTab==='clash')?'clash':'general';
  const m=currentModalGeneralImports[mode]||{};
  const uri=(u.includes('android')?m.v2rayng:'') || m.v2rayn || m.v2rayng || '';
  if(!uri){ toast('当前链接不支持通用导入','err'); return; }
  location.href=uri;
}



async function copyAnyText(txt, okMsg='已复制链接'){
  const t=String(txt||'').trim();
  if(!t) return toast('没有可复制的链接','err');
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(t);
    }else{
      const ta=document.createElement('textarea');
      ta.value=t; ta.style.position='fixed'; ta.style.left='-9999px';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(okMsg,'ok');
  }catch(e){
    toast('复制失败，请手动复制','err');
  }
}


function normalizeFullUrlForDisplay(raw){
  let u=String(raw||'').trim();
  if(!u) return '';
  try{
    const url=new URL(u);
    const badHosts=new Set(['127.0.0.1','localhost','0.0.0.0','::1','[::1]']);
    const h=url.hostname||'';
    const isPrivate=/^10\\./.test(h)||/^192\\.168\\./.test(h)||/^172\\.(1[6-9]|2\\d|3[0-1])\\./.test(h)||/^127\\./.test(h);
    if(badHosts.has(h)||isPrivate){
      const publicHost=(location.hostname&&location.hostname!=='localhost'&&location.hostname!=='127.0.0.1')?location.hostname:'';
      if(publicHost) url.hostname=publicHost;
      if(location.protocol==='https:') url.protocol='https:';
      if((location.protocol==='https:'&&url.port==='8780')||url.port==='') url.port='';
      u=url.toString();
    }
  }catch{}
  return u;
}


function renderSubsUI(arr){
  const box=q('#subs');
  if(!arr.length){box.innerHTML='<div class="muted">暂无</div>';return;}
  box.innerHTML='';
  for(const s of arr){
    const full=normalizeFullUrlForDisplay(s.full_url||(\`\${location.origin}\${s.url}\`));
    const clashUrl = full.endsWith('/clash') ? full : \`\${full}/clash\`;
    const clashImportUri=\`clash://install-config?url=\${encodeURIComponent(clashUrl)}&name=\${encodeURIComponent((s.name||'sui-sub')+'-Clash版')}\`;
    const generalImportUris={
      v2rayn:\`v2rayn://install-config?url=\${encodeURIComponent(full)}&remark=\${encodeURIComponent((s.name||'sui-sub')+'-通用')}\`,
      v2rayng:\`v2rayng://install-config?url=\${encodeURIComponent(full)}&remark=\${encodeURIComponent((s.name||'sui-sub')+'-通用')}\`
    };
    const row=document.createElement('div');row.className='src-item';
    row.innerHTML=\`<div class="row" style="justify-content:space-between"><div style="flex:1 1 460px;min-width:280px"><b>\${esc(s.name||'')}</b><div class="muted">源：\${esc(((s.source_names||[]).join(', ')||'-'))} · 节点数：\${Number((s.node_ids||[]).length||0)}</div><input readonly value="\${esc(full)}" style="margin-top:8px;width:min(82%,560px)"></div><div class="row" style="justify-content:flex-end"><button data-act="copy">复制通用</button><button data-act="copy-clash">复制Clash</button><button data-act="edit">编辑</button><button data-act="delete">删除</button></div></div>\`;
    row.querySelector('input').onclick=e=>e.target.select();
    row.querySelector('[data-act="copy"]').onclick=()=>openLinkModal(full, clashImportUri, generalImportUris);
    row.querySelector('[data-act="copy-clash"]').onclick=()=>openLinkModal(clashUrl, clashImportUri, {}, 'clash');
    row.querySelector('[data-act="edit"]').onclick=()=>openSubModal(s);
    row.querySelector('[data-act="delete"]').onclick=()=>deleteSub(s.id);
    box.appendChild(row);
  }
}
async function loadSubs(){ const j=await api('/api/view/subscriptions'); renderSubsUI(j.subscriptions||[]); }
async function deleteSub(id){if(!confirm('确认删除此订阅？'))return;await api('/api/subscriptions/'+id,{method:'DELETE'});loadSubs();}

function renderModalSourceFilter(){
  const sel=q('#modalSourceFilter'); if(!sel) return;
  const old=sel.value||'all';
  sel.innerHTML='<option value="all">全部源</option>'+orderedSources().map(s=>\`<option value="\${Number(s.id||0)}">\${esc(s.name||'')}\${String(s.source_type||'sui_api')==='local'?'（本地）':''}</option>\`).join('');
  sel.value=[...sel.options].some(o=>o.value===old)?old:'all';
  sel.onchange=async()=>{
    const sid=sel.value||'all';
    const j=await api('/api/view/modal-nodes'+(sid!=='all'?\`?sourceId=\${sid}\`:''));
    modalAllNodes=j.nodes||[];
    renderSubModal();
  };
}
function modalNodes(){
  const sid=q('#modalSourceFilter')?.value||'all';
  const srcMap=new Map((sources||[]).map(s=>[String(s.id),s]));
  const filteredAll=(modalAllNodes||[]).filter(n=>{
    const src=srcMap.get(String(n.source_id));
    if(isCfSource(src||{})) return passCfFilter(n);
    return true;
  });
  return sid==='all' ? filteredAll : filteredAll.filter(n=>String(n.source_id)===sid);
}
function pruneSelectedByCfFilter(){
  // 订阅编辑时，避免“筛选外的 CF 节点”继续残留在已选列表里
  const nodeById=new Map((modalAllNodes||[]).map(n=>[Number(n.id), n]));
  const sourceById=new Map((sources||[]).map(s=>[Number(s.id), s]));
  for(const id of [...selectedNodeIds]){
    const n=nodeById.get(Number(id));
    if(!n) continue;
    const src=sourceById.get(Number(n.source_id)) || {name:n.source_name, source_type:n.source_type};
    if(!isCfSource(src)) continue;
    if(!passCfFilter(n)) selectedNodeIds.delete(Number(id));
  }
}
function renderSubModal(){
  pruneSelectedByCfFilter();
  const picked=q('#modalPicked'), list=q('#modalNodeList'), nodes=modalNodes();
  const chosen=modalAllNodes.filter(n=>selectedNodeIds.has(n.id));
  picked.innerHTML=chosen.length?chosen.map(n=>\`<span class="chip">\${esc(n.node_name||('#'+n.id))} <a href="javascript:void(0)" data-rm="\${n.id}" style="color:#c9d2ff;text-decoration:none">×</a></span>\`).join(''):'<span class="muted">未选择节点</span>';
  list.innerHTML=nodes.length?\`<div class="modal-node-grid">\${nodes.map(n=>\`<label class="modal-node-item" style="display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px;border:1px solid #2b3963;border-radius:10px;background:#0d1530;cursor:pointer"><div style="min-width:0"><div style="color:#eef2ff;line-height:1.35;white-space:normal;word-break:normal;overflow-wrap:anywhere">\${esc(n.node_name||('#'+n.id))}</div><div style="color:rgba(238,242,255,.72);font-size:12px;margin-top:2px;white-space:normal;word-break:normal;overflow-wrap:anywhere">\${esc(n.source_name||n.source_id)}</div></div><input type="checkbox" data-nid="\${n.id}" \${selectedNodeIds.has(n.id)?'checked':''} style="width:18px;height:18px;justify-self:end"></label>\`).join('')}</div>\`:'<div class="muted">该源暂无节点</div>';
  list.querySelectorAll('input[data-nid]').forEach(el=>el.onchange=(e)=>{const id=Number(e.target.dataset.nid);if(e.target.checked)selectedNodeIds.add(id);else selectedNodeIds.delete(id);renderSubModal();});
  picked.querySelectorAll('[data-rm]').forEach(el=>el.onclick=()=>{selectedNodeIds.delete(Number(el.dataset.rm));renderSubModal();});
}
async function openSubModal(sub=null){
  editingSubId=sub?.id||null;
  q('#subModalTitle').textContent=sub?'编辑订阅':'新建订阅';
  q('#modalSubName').value=sub?.name||'';
  if(q('#modalAutoPrune')) q('#modalAutoPrune').checked=Number(sub?.auto_prune_unreachable||0)===1;
  selectedNodeIds.clear();
  (sub?.node_ids||[]).forEach(id=>selectedNodeIds.add(Number(id)));

  // 切换到编辑某个订阅时，恢复该订阅自己的筛选状态，避免沿用上一个订阅/页面的 draft
  const key=String(editingSubId||'new');
  const snap=subFilterState[key]||{};
  cfFilterDraft={};
  for(const [sid,val] of Object.entries(snap)){
    cfFilterDraft[String(sid)]={
      transport:new Set([...(val?.transport||[])]),
      hostType:new Set([...(val?.hostType||[])]),
      alpn:new Set([...(val?.alpn||[])]),
      tag:new Set([...(val?.tag||[])])
    };
  }

  const sid=q('#modalSourceFilter')?.value||'all';
  const j=await api('/api/view/modal-nodes'+(sid!=='all'?\`?sourceId=\${sid}\`:''));
  modalAllNodes=j.nodes||[];
  renderSubModal();
  q('#subModal').classList.remove('hide');
}
function closeSubModal(){q('#subModal').classList.add('hide')}
async function saveSubModal(){
  const nodeIds=[...selectedNodeIds], name=(q('#modalSubName').value||'').trim()||\`sub-\${Date.now()}\`;
  const autoPrune=q('#modalAutoPrune')?.checked?1:0;
  if(!nodeIds.length)return toast('请先选择节点','err');
  if(editingSubId) await api('/api/subscriptions/'+editingSubId,{method:'PUT',body:JSON.stringify({name,node_ids:nodeIds,auto_prune_unreachable:autoPrune})});
  else await api('/api/subscriptions',{method:'POST',body:JSON.stringify({name,node_ids:nodeIds,auto_prune_unreachable:autoPrune})});

  // 持久化当前订阅的筛选快照（仅用于前端会话态恢复）
  const key=String(editingSubId||'new');
  subFilterState[key]={};
  for(const [sid,val] of Object.entries(cfFilterDraft||{})){
    subFilterState[key][String(sid)]={
      transport:[...(val?.transport||[])],
      hostType:[...(val?.hostType||[])],
      alpn:[...(val?.alpn||[])],
      tag:[...(val?.tag||[])]
    };
  }

  closeSubModal();
  loadSubs();
}

function loadSuiSourceOptions(){const sel=q('#suiSource');if(!sel)return;const prev=sel.value;const suiSources=sources.filter(s=>String(s?.source_type||'sui_api')==='sui_api' && !isLocalSource(s));sel.innerHTML=suiSources.length?suiSources.map(s=>\`<option value="\${Number(s.id||0)}">\${esc(s.name||'')} (\${esc(s.panel_url||'')})</option>\`).join(''):'<option value="">暂无可管理的 SUI 源</option>';if(prev&&[...sel.options].some(o=>o.value===prev))sel.value=prev;sel.onchange=()=>loadSuiNodes();}
async function loadSuiNodes(){const sel=q('#suiSource'),box=q('#suiNodes');if(!sel||!sel.value){box.innerHTML='<div class="muted">暂无可管理的 SUI 源（本地源不在此页管理）</div>';return;}const sourceId=Number(sel.value);try{const j=await api(\`/api/sui/\${sourceId}/inbounds\`),arr=j.inbounds||[];if(!arr.length){box.innerHTML='<div class="muted">暂无节点</div>';return;}box.innerHTML=\`<table><thead><tr><th>ID</th><th>备注</th><th>协议</th><th>端口</th><th>状态</th><th>操作</th></tr></thead><tbody>\${arr.map(i=>\`<tr><td>\${Number(i.id||0)}</td><td>\${esc(i.remark||'')}</td><td>\${esc(i.protocol||'')}</td><td>\${esc(i.port||'')}</td><td>\${i.enable?'<span class="ok">启用</span>':'<span class="err">停用</span>'}</td><td><button onclick="renameSuiInbound(\${sourceId},\${Number(i.id||0)},'\${encodeURIComponent(i.remark||'')}')">改名</button> <button onclick="deleteSuiInbound(\${sourceId},\${Number(i.id||0)})">删除</button></td></tr>\`).join('')}</tbody></table>\`;}catch(e){box.innerHTML=\`<div class="err">加载失败：\${esc(e.message)}</div>\`;}}
async function quickReality(){const sel=q('#suiSource');if(!sel||!sel.value)return toast('请先选择可管理的 SUI 源','err');const sourceId=Number(sel.value);const remark=(q('#realityName')?.value||'').trim()||\`quick-\${Date.now()}\`;await api(\`/api/sui/\${sourceId}/reality-quick\`,{method:'POST',body:JSON.stringify({remark})});q('#realityName').value='';toast(\`已创建 Reality 节点：\${remark}\`,'ok');await refreshAll();await loadSuiNodes();}
async function renameSuiInbound(sourceId,inboundId,oldRemarkEnc=''){const old=decodeURIComponent(oldRemarkEnc||'');const remark=prompt('输入新备注：',old);if(remark===null)return;const v=String(remark||'').trim();if(!v)return toast('备注不能为空','err');await api(\`/api/sui/\${sourceId}/inbounds/\${inboundId}/rename\`,{method:'PUT',body:JSON.stringify({remark:v})});toast('节点备注已更新','ok');await refreshAll();await loadSuiNodes();}
async function deleteSuiInbound(sourceId,inboundId){if(!confirm('确认删除该节点？'))return;await api(\`/api/sui/\${sourceId}/inbounds/\${inboundId}\`,{method:'DELETE'});toast('节点已删除','ok');await refreshAll();await loadSuiNodes();}

function renderConnectivityStatus(st={}){
  const el=q('#connectivityStatus');
  if(!el) return;
  const running=Number(st.running||0)===1;
  const lastAt=st.last_at?new Date(st.last_at).toLocaleString():'未执行';
  const checked=Number(st.last_checked||0);
  const ok=Number(st.last_ok||0);
  const fail=Number(st.last_fail||0);
  const dur=Number(st.last_duration_ms||0);
  const err=String(st.last_error||'').trim();
  el.textContent=\`连通性状态：\${running?'扫描中':'空闲'} ｜ 最近执行：\${lastAt} ｜ 扫描\${checked}个（ok \${ok} / fail \${fail}）\${dur?\` ｜ 耗时 \${dur}ms\`:''}\${err?\` ｜ 错误：\${err}\`:''}\`;
}

async function loadAdminUser(){
  const j=await api('/api/admin/user');
  q('#adminUser').value=j.username||'';
  q('#adminPass').value='';
  if(q('#autoConnectivityMin')) q('#autoConnectivityMin').value=Math.max(1,Math.round(Number(j.auto_connectivity_ms||600000)/60000));
  if(q('#autoConnectivityLimit')) q('#autoConnectivityLimit').value=Number(j.auto_connectivity_limit||60);
  renderConnectivityStatus(j.connectivity_status||{});
  await loadSubLogs();
}

async function saveAdminUser(){
  const username=(q('#adminUser').value||'').trim(),password=(q('#adminPass').value||'').trim();
  const autoMin=Math.max(1,Number(q('#autoConnectivityMin')?.value||10));
  const autoLimit=Math.max(1,Math.min(200,Number(q('#autoConnectivityLimit')?.value||60)));
  if(!username)return toast('用户名必填','err');
  if(password&&password.length<6)return toast('密码至少6位（或留空不改）','err');
  const j=await api('/api/admin/user',{method:'POST',body:JSON.stringify({username,password,auto_connectivity_ms:autoMin*60000,auto_connectivity_limit:autoLimit})});
  q('#adminPass').value='';
  renderConnectivityStatus(j.connectivity_status||{});
  toast('用户与连通性设置已更新并生效','ok');
}

async function runConnectivityNow(){
  const j=await api('/api/admin/connectivity/run-now',{method:'POST',body:'{}'});
  renderConnectivityStatus(j.connectivity_status||{});
  toast('已完成一次连通性扫描','ok');
}

async function loadSubLogs(){
  const box=q('#subLogs');
  if(!box) return;
  try{
    const j=await api('/api/admin/subscription-logs?limit=10');
    const arr=j.logs||[];
    if(!arr.length){box.innerHTML='<div class="muted">暂无日志</div>';return;}
    box.innerHTML=\`<div style="overflow-x:auto"><table><thead><tr><th>时间</th><th>订阅</th><th>类型</th><th>设备</th><th>IP</th><th>User-Agent</th></tr></thead><tbody>\${arr.map(x=>\`<tr><td>\${new Date(x.created_at).toLocaleString()}</td><td>\${esc(x.subscription_name||x.token||'')}</td><td>\${esc(x.route_type||'')}</td><td>\${esc(x.device_hint||'unknown')}</td><td>\${esc(x.client_ip||'')}</td><td title="\${esc(x.user_agent||'')}">\${esc((x.user_agent||'').slice(0,80))}\${(x.user_agent||'').length>80?'...':''}</td></tr>\`).join('')}</tbody></table></div>\`;
  }catch(e){
    box.innerHTML=\`<div class="err">日志加载失败：\${esc(e.message)}</div>\`;
  }
}

function applyBootstrap(b){
  sources=b.sources||[];
  if(!sources.some(x=>String(x.id)===String(sourceViewId))) sourceViewId='all';
  const sid=(sourceViewId==='all'?0:Number(sourceViewId)||0);
  const nodes=(b.nodes||[]);
  allNodes = sid ? nodes.filter(n=>Number(n.source_id)===sid) : nodes;
  renderSourcesUI();
  renderNodeSourceSelect();
  setLocalAddVisible();
  renderNodes();
  renderSubsUI(b.subscriptions||[]);
}

async function refreshAll(){
  const pageY=window.scrollY||0;
  const nodeBox=q('#nodes');
  const nodeScroll=nodeBox?nodeBox.scrollTop:0;
  const b=await api('/api/view/bootstrap');
  applyBootstrap(b);
  await refreshKernelStatus();
  if(activeTab==='nodes'){
    const nb=q('#nodes');
    if(nb) nb.scrollTop=nodeScroll;
    window.scrollTo(0,pageY);
  }
}
async function init(){
  let initialTab='home';
  try{
    const saved=localStorage.getItem('sui_sub_last_tab')||'home';
    if(['home','nodes','sui','user'].includes(saved)) initialTab=saved;
  }catch(_e){}
  switchTab(initialTab);
  await refreshAll();
  setInterval(async()=>{
    if(!q('#tab-user')?.classList.contains('hide')) await loadSubLogs();
  },5000)
}
q('#lp')?.addEventListener('keydown',e=>{if(e.key==='Enter')login()});
try{ applyTheme(localStorage.getItem('sui_sub_theme')||'dark'); }catch(_e){ applyTheme('dark'); }
checkAuth();
</script>
</body>
</html>
`;
}
