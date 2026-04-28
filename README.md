# sui-sub

**一个面向多服务器场景的 SUI 订阅编排与分发平台。**

`sui-sub` 让你把多台 `sui` 面板里的节点聚合到一个控制台，按需挑选节点，生成可直接导入客户端的订阅链接。

---

## Quick Overview

| 能力 | 是否支持 |
|---|:---:|
| 多 SUI 源接入与统一管理 | ✅ |
| 自动同步节点 | ✅ |
| 安全访问上游面板（`/panel-proxy/:id/*`） | ✅ |
| 节点级订阅编辑（按源/按节点组合） | ✅ |
| 多订阅链接管理 | ✅ |
| 本地节点手工录入 | ✅ |
| SUI 管理页（一键 Reality / 节点操作） | ✅ |

---

## 它适合谁？

适合：
- 有多台 VPS、多套 SUI 面板
- 想把节点统一编排，再按设备分发订阅
- 想减少手工复制链接、改名、对齐配置的重复劳动

不适合：
- 只维护单机单面板，且不需要订阅编排

---

## 与 SUI 的关系（重要）

- `sui`：节点生命周期管理（创建、修改、运行）
- `sui-sub`：聚合多个 `sui`，做订阅编排与统一分发

先装 `sui`，再用 `sui-sub` 聚合分发。

- SUI 项目地址：https://github.com/Spittingjiu/sui
- SUI 一键安装：`bash <(curl -fsSL https://raw.githubusercontent.com/Spittingjiu/sui/main/install.sh)`

---

## 三步快速上手

### 1) 安装并启动

#### 方式 A：Docker Compose（推荐）

```bash
mkdir -p /opt/sui-sub && cd /opt/sui-sub
git clone https://github.com/Spittingjiu/sui-sub.git .
mkdir -p data
docker compose up -d --build
```

启动后访问：`http://<服务器IP>:8780`

#### 方式 B：Docker

```bash
docker build -t sui-sub:latest .
docker run -d \
  --name sui-sub \
  -p 8780:8780 \
  -e SUI_SUB_USER=admin \
  -e SUI_SUB_PASS=admin123 \
  -e SUI_SUB_SESSION_SECRET=change-me-please \
  -e SUI_SUB_SYNC_MS=300000 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  sui-sub:latest
```

#### 方式 C：Node 原生运行

```bash
npm install
npm start
```

默认端口：`8780`

---

### 2) 首次登录

使用环境变量里的账号密码登录（默认 `admin / admin123`）。

> 建议上线后第一时间修改默认密码与 `SUI_SUB_SESSION_SECRET`。

---

### 3) 添加 SUI 源并生成订阅

1. 进入“源”页，填写：
   - 名称
   - 面板地址（如 `http://x.x.x.x:12345`）
   - Token（也可填 `用户名:密码`，系统会自动换取 token）
2. 保存后自动同步节点
3. 在“节点&订阅”里选择节点，创建订阅
4. 复制订阅链接导入客户端

---

## 安全访问（推荐）

`sui-sub` 支持从源列表点击“安全访问”，通过：

`/panel-proxy/:sourceId/*`

反向代理访问上游 SUI 面板，统一从 `sui-sub` 域名入口操作，减少直接暴露上游面板地址的需求。

### 常见问题

- **点登录没反应**：先强刷（Ctrl+F5）再试；确认源页面已更新到新前端。
- **提示 non-json response**：通常是路径前缀或代理链路问题，优先检查 `/panel-proxy/:id` 路径。
- **账号不对**：SUI 登录账号以目标 SUI 面板本身配置为准，不是 sub 账号。

---

## 主要能力说明

- 多源聚合：统一查看多个 SUI 面板的节点
- 自动同步：按配置间隔拉取上游节点
- 本地节点：支持手工录入节点并纳入订阅
- 节点编辑：节点重命名、开关、按源筛选
- 订阅编排：按节点组合输出多条订阅链接
- SUI 管理：在 sub 中直接执行部分 SUI 管理动作

---

## 环境变量

- `PORT`：服务端口（默认 `8780`）
- `SUI_SUB_USER`：管理账号（默认 `admin`）
- `SUI_SUB_PASS`：管理密码（默认 `admin123`）
- `SUI_SUB_SESSION_SECRET`：会话签名密钥（**务必修改**）
- `SUI_SUB_SYNC_MS`：自动同步间隔（毫秒，默认 `300000`）

---

## 目录说明

- `server.js`：后端 API 与业务逻辑
- `public/`：前端页面
- `data/`：数据库与运行数据（需持久化）
- `scripts/`：运维与回归脚本

---

## 回归检查（推荐）

新增了 Sprint A 冒烟脚本，用于发布前快速确认关键链路可用：

```bash
# 检查 sub 登录 + 安全访问代理登录链路
SUB_BASE=http://127.0.0.1:8780 \
SUB_USER=你的sub账号 \
SUB_PASS=你的sub密码 \
SOURCE_ID=7 \
bash scripts/sprint-a-proxy-smoke.sh
```

通过后再发布，可显著降低回归风险。

---

## ☁️ Workers 完整版使用教程（`赛博菩萨.js`）

> 你要求的“完整 Workers 版”主文件已经在仓库：`赛博菩萨.js`。
> 这一节只讲怎么用，不做旧库迁移。

### 1) 前置准备

- 一个 Cloudflare 账号
- 已安装 `wrangler`（建议 v3+）
- 已登录：

```bash
npx wrangler login
```

### 2) 创建 Workers 项目并放入主文件

在本仓库目录执行：

```bash
# 可选：初始化最小 wrangler 配置
npx wrangler init sui-sub-workers
```

然后将 `赛博菩萨.js` 作为 Worker 入口（你可以直接用它替换默认 `src/index.js`，或在 wrangler 里指定 `main`）。

### 3) 配置 `wrangler.toml`（核心）

示例（按你的实际 ID 替换）：

```toml
name = "sui-sub-workers"
main = "赛博菩萨.js"
compatibility_date = "2026-04-28"

[[d1_databases]]
binding = "DB"
database_name = "sui-sub-db"
database_id = "<你的D1数据库ID>"

# 可选：若后续要做缓存/静态资源
# [[kv_namespaces]]
# binding = "CACHE_KV"
# id = "<你的KV_ID>"
```

### 4) 创建 D1 并初始化表

先建库：

```bash
npx wrangler d1 create sui-sub-db
```

然后执行初始化 SQL（新建 `schema.sql`，至少包含以下表）：

- `sources`
- `nodes`
- `subscriptions`
- `node_connectivity`

最小示例：

```sql
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  panel_url TEXT NOT NULL,
  panel_token TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'sui_api',
  enabled INTEGER NOT NULL DEFAULT 1,
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
  UNIQUE(source_id, node_hash)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  node_ids_json TEXT NOT NULL DEFAULT '[]',
  auto_prune_unreachable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_connectivity (
  node_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown',
  latency_ms INTEGER,
  last_error TEXT,
  checked_at TEXT NOT NULL
);
```

执行：

```bash
npx wrangler d1 execute sui-sub-db --file=./schema.sql
```

### 5) 设置密钥

`赛博菩萨.js` 需要以下环境变量：

- `ADMIN_PASSWORD`（登录密码）
- `SESSION_SECRET`（会话签名密钥，建议高强度随机）

设置命令：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

### 6) 本地联调

```bash
npx wrangler dev
```

访问本地地址后：

- `POST /api/auth/login`：用 `ADMIN_PASSWORD` 登录
- `GET /api/auth/me`：检查会话
- `GET /api/sources`：查看源
- `GET /sub/:token`：下发订阅（会先触发一次该订阅连通性检测）

### 7) 发布上线

```bash
npx wrangler deploy
```

上线后即可通过 `https://<worker域名>` 访问。

---

### 注意事项（务必看）

1. `赛博菩萨.js` 是 Workers 全量主干，适配的是 D1 数据模型，不是本地 SQLite 文件。  
2. 你要求“不迁移旧数据”，那就按新库直接开始使用。  
3. 连通性检测在 Workers 内不做原生 TCP 直连，当前走上游 `sui_api` 的链路测试接口。  
4. 若要接入你现有完整前端 UI，可把当前 `buildHtml()` 替换为静态资源分发（Pages/Assets）。

## API Documentation

- English: `docs/API.md`
- 中文：`docs/API.zh-CN.md`

## License

GPL-3.0
