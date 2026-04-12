# sui-sub API 文档（中文）

基础地址：`http://<host>:8780`

认证方式：
- 通过 `/api/auth/login` 登录后下发 cookie 会话（`sui_sub_session`）。
- 大多数管理接口需要已登录会话。

---

## 认证

### POST `/api/auth/login`
请求示例：
{
  "username": "admin",
  "password": "admin123"
}

成功响应示例：
{
  "ok": true,
  "username": "admin"
}

### POST `/api/auth/logout`
退出登录。

### GET `/api/auth/me`
检查当前会话状态。

---

## 管理员与日志

- GET `/api/admin/user`：获取管理员账号信息
- POST `/api/admin/user`：更新管理员账号/密码/模板 URL
- GET `/api/admin/subscription-logs`：获取订阅访问日志

---

## 源管理（Sources）

- GET `/api/sources`：源列表
- POST `/api/sources`：新增源（token 或 `用户名:密码`）
- PUT `/api/sources/:id`：更新源
- DELETE `/api/sources/:id`：删除源
- POST `/api/sources/sync-all`：触发全量同步

---

## 安全访问代理

### ALL `/panel-proxy/:sourceId/*`
通过反代安全访问上游 SUI 面板页面与 API。

常见使用：
- 打开面板：`/panel-proxy/:sourceId/`
- 代理登录：`/panel-proxy/:sourceId/auth/login`

---

## 视图初始化接口（前端用）

- GET `/api/view/home`
- GET `/api/view/nodes`
- GET `/api/view/bootstrap`
- GET `/api/view/modal-nodes`
- GET `/api/view/subscriptions`

---

## 节点管理

- GET `/api/nodes`：节点列表
- POST `/api/nodes/:id/toggle`：启用/禁用节点
- POST `/api/local-nodes`：新增本地节点
- PUT `/api/nodes/:id/rename`：重命名节点
- DELETE `/api/local-nodes/:id`：删除本地节点

---

## 连通性 / 内核

- GET `/api/kernel/status`：mihomo 安装状态
- POST `/api/kernel/install`：安装 mihomo
- POST `/api/kernel/uninstall`：卸载 mihomo
- POST `/api/nodes/connectivity/check`：触发连通性检测
- GET `/api/nodes/connectivity`：查询连通性结果

---

## SUI 桥接接口

- GET `/api/sui/:sourceId/inbounds`：读取上游 SUI 入站
- POST `/api/sui/:sourceId/reality-quick`：上游一键创建 Reality
- DELETE `/api/sui/:sourceId/inbounds/:inboundId`：删除上游入站
- GET `/api/bridge/e2ee-meta`：获取 E2EE 元信息
- POST `/api/bridge/push-source`：由 SUI 推送源到 sub

---

## 订阅管理

- GET `/api/subscriptions`：订阅列表
- POST `/api/subscriptions`：创建订阅
- PUT `/api/subscriptions/:id`：更新订阅
- DELETE `/api/subscriptions/:id`：删除订阅

---

## 订阅下发

- GET `/sub/:token`：纯链接订阅
- GET `/api/sub/:token/plain`：纯链接订阅（API 路径）
- GET `/sub/:token/clash`：Clash YAML 订阅
- GET `/api/sub/:token/clash`：Clash YAML 订阅（API 路径）

---

## 通用返回格式

成功：
{
  "ok": true,
  "...": "..."
}

失败：
{
  "ok": false,
  "error": "错误信息"
}

状态码语义遵循常规 HTTP（`400/401/403/404/500`）。
