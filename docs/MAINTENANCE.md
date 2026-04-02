# SUI-Sub 维护手册

## 当前边界（重要）
- `sui-sub` 只负责注入 `proxies`（节点）。
- 其余配置（策略组/规则/DNS/rule-providers）由模板决定。
- 默认模板 URL：`https://raw.githubusercontent.com/Spittingjiu/mihomo-generic-template/main/clash-template.yaml`

## 关键仓库
- 面板与后端：`Spittingjiu/sui-sub`
- 通用模板：`Spittingjiu/mihomo-generic-template`
- 白名单规则：`Spittingjiu/mihomo-custom-rules`

## 日常改动流程（建议）
1. 先改模板仓库（`mihomo-generic-template`）
2. 运行本地校验脚本（`scripts/validate-template.mjs`）
3. 再改 `sui-sub`（仅在需要回退模板同步时）
4. 发布后在面板执行一次订阅更新，检查日志

## 回滚
- 模板回滚：在 `mihomo-generic-template` 回退到上个 commit 并 push
- 服务回滚：`/opt/sui-sub` 执行 `git log --oneline -n 20` 找到目标后 `git reset --hard <commit>` 并 `systemctl restart suisub.service`

## 常见问题
- 看到 DIRECT：检查模板 `proxy-groups` 是否开启 `include-all-proxies` 且未设置 `exclude-filter`
- SUI 管理报 local://manual 错误：确认前端已过滤本地源（local source 不在 SUI 管理页）
- 模板切换后异常：先检查模板语法和组名引用是否存在
