# sui-sub

SUI 订阅管理站：支持多源 SUI 面板聚合、自动同步、节点选择式订阅、SUI 面板节点管理（一键 Reality / 删除节点）。

## 🚀 和 SUI Panel 一起用，才是完整体验
把它想象成一条流水线：
- `sui` 在前线管节点、做运维
- `sui-sub` 在后线做编排、发订阅

当你的节点分散在多台机器，或者你想给「手机 / 平板 / 电脑」发不同套餐时，`sui-sub` 能把这些零散节点整理成清晰、可维护、可一键导入的订阅链接。

先装好 SUI Panel：
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
