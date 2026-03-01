# sui-sub

SUI 订阅管理站：支持多源 SUI 面板聚合、自动同步、节点选择式订阅、SUI 面板节点管理（一键 Reality / 删除节点）。

## Features
- 登录鉴权（用户名/密码）
- 多 SUI 源接入与自动同步
- 节点级订阅编辑（弹窗多选节点）
- 多订阅链接管理 + 一键导入
- SUI 管理页：一键 Reality、删除节点

## Run
```bash
npm install
npm start
```

默认端口：`8780`

## Env
- `SUI_SUB_USER` 默认 `admin`
- `SUI_SUB_PASS` 默认 `admin123`
- `SUI_SUB_SESSION_SECRET` 会话签名密钥
- `SUI_SUB_SYNC_MS` 自动同步间隔（毫秒，默认 5 分钟）
