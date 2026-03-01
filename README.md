# sui-sub

SUI 订阅管理站：支持多源 SUI 面板聚合、自动同步、节点选择式订阅、SUI 面板节点管理（一键 Reality / 删除节点）。

## 🚀 基于 SUI Panel 的订阅编排台
`SUI Panel (sui)` 是本项目的必备基础层；`sui-sub` 基于其 API 提供订阅编排、策略分发与多端交付能力。

架构职责：
- `sui`：节点生命周期管理与运行维护
- `sui-sub`：跨面板节点聚合、订阅策略编排、统一分发出口

适用场景：
- 多台服务器 / 多套面板的节点统一管理
- 按设备（手机 / 平板 / 电脑）下发差异化订阅组合
- 将离散节点沉淀为可维护、可审计、可一键导入的订阅资产

先安装 SUI Panel（必需前置）：
- 项目地址：https://github.com/Spittingjiu/sui
- 一键安装：`bash <(curl -fsSL https://raw.githubusercontent.com/Spittingjiu/sui/main/install.sh)`

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

## Docker 安装
### 方式1：Docker Compose（推荐）
```bash
mkdir -p /opt/sui-sub && cd /opt/sui-sub
git clone https://github.com/Spittingjiu/sui-sub.git .
mkdir -p data
docker compose up -d --build
```

启动后访问：`http://服务器IP:8780`

### 方式2：纯 Docker
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

## Env
- `SUI_SUB_USER` 默认 `admin`
- `SUI_SUB_PASS` 默认 `admin123`
- `SUI_SUB_SESSION_SECRET` 会话签名密钥（务必修改）
- `SUI_SUB_SYNC_MS` 自动同步间隔（毫秒，默认 5 分钟）
