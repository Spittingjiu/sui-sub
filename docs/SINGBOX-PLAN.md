# sing-box 分流迁移（并行方案，不影响现网 Clash）

## 目标
在不动现有 Clash 业务的前提下，新增一条 sing-box 配置产线，支持主要分流能力。

## 当前落地状态
- 已新增转换脚本：`scripts/clash_to_singbox.mjs`
- 已生成测试模板：`experimental/singbox/singbox-template.json`
- 已通过 sing-box 官方容器 `check`（语法/结构可启动级通过）
- 未接入线上接口，不影响现有 `sui-sub` 业务。

## 使用方法（离线验证）
1. 准备 Clash 模板 JSON（当前默认：`/tmp/clash-generic-template/clash-template.json`）
2. 执行：
   - `node scripts/clash_to_singbox.mjs /tmp/clash-generic-template/clash-template.json /opt/sui-sub/experimental/singbox/singbox-template.json`
3. 验证输出结构：
   - `jq '.outbounds|length' experimental/singbox/singbox-template.json`
   - `jq '.route.rules|length' experimental/singbox/singbox-template.json`
   - `jq '.route.rule_set|length' experimental/singbox/singbox-template.json`

## 说明
- 转换脚本已支持常见规则：`RULE-SET / DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / GEOSITE / IP-CIDR / MATCH`
- 复杂特性需逐步补齐（例如某些 Clash 专有行为）。
- 当前产物用于并行测试，确认稳定后再决定是否接面板入口。

## 下一步建议
1. 加一份小规模真实节点样本，跑 sing-box 本地启动验证
2. 对齐策略组命名与分流命中结果
3. 评估后决定是否新增 `/sub/:token/singbox` 只读导出接口（不改现有 clash 接口）


## 本轮验证结论
- 启动级校验通过（docker: `ghcr.io/sagernet/sing-box:latest check -c /cfg.json`）。
- 为兼容 sing-box >=1.12，暂时跳过了 geosite 旧字段直转（后续可补新规则集映射）。
