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

## ☁️ Workers 完整版使用教程（`赛博菩萨.js`，网页端版）

> 你要求的“完整 Workers 版”主文件已经在仓库：`赛博菩萨.js`。  
> 本教程按“纯网页端”写，不依赖 VPS 命令行，不迁移旧数据。

### 1) 在 Cloudflare 创建 Worker（网页）

1. 打开 Cloudflare Dashboard → **Workers & Pages**
2. 点 **Create** → **Worker**
3. 进入编辑器后，把默认代码全部替换为仓库里的 `赛博菩萨.js`
4. 点击 **Deploy**

---

### 2) 创建并绑定 D1（网页）

1. 打开 **Storage & Databases** → **D1 SQL Database**
2. 点击 **Create**，创建 `sui-sub-db`（名称可自定义）
3. 回到你的 Worker → **Settings** → **Bindings**
4. 添加 D1 绑定：
   - Variable name: `DB`
   - Database: 选择你刚创建的 D1

---

### 3) 添加 Secrets（网页）

Worker → **Settings** → **Variables and Secrets**，添加以下 Secret：

- `ADMIN_PASSWORD`：你的管理登录密码
- `SESSION_SECRET`：会话签名密钥（建议长随机串）
- `INIT_KEY`：初始化口令（用于一键建表）

保存并重新部署。

---

### 4) 一键自动建表（无需手贴 SQL）

浏览器访问：

```text
https://<你的worker域名>/init?key=<你的INIT_KEY>
```

返回 `schema initialized` 即表示 D1 表结构初始化完成。

> 建议初始化后删除或重置 `INIT_KEY`，避免被重复触发。

---

### 5) 登录与使用

- 打开 `https://<你的worker域名>/`
- 用 `ADMIN_PASSWORD` 登录
- 后续即可在页面里管理：源、节点、订阅下发

---

### 6) 关键说明

1. 这是完整功能版，数据依赖 D1（不是本地 SQLite）。  
2. 你要求“不迁移旧数据”，当前就是新库起用。  
3. 订阅下发时会先触发该订阅的一轮连通性检测，再按结果下发。  
4. Workers 环境不做原生 TCP 直连，连通性检测走上游 `sui_api` 链路测试接口。

---

### 7) 可选：CLI 同步方案（仅备查）

如果你后续想走命令行部署，再看本仓库的 wrangler 方案即可；当前网页端流程已可完整上线。

## API Documentation

- English: `docs/API.md`
- 中文：`docs/API.zh-CN.md`

## License

GPL-3.0
