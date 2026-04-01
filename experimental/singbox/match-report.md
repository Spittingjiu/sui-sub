# Clash vs sing-box 分流命中对照

- Clash 模板: /tmp/clash-generic-template/clash-template.json
- sing-box 模板: experimental/singbox/singbox-template.json

| 域名 | Clash 命中 | sing-box 命中 | 结论 |
|---|---|---|---|
| music.qq.com | DIRECT | direct | ✅ 一致 |
| www.anyrouter.top | DIRECT | direct | ✅ 一致 |
| riotgames.com | DIRECT | direct | ✅ 一致 |
| openai.com | AI分流 | AI分流 | ✅ 一致 |
| claude.ai | AI分流 | AI分流 | ✅ 一致 |
| youtube.com | YouTube分流 | YouTube分流 | ✅ 一致 |
| t.me | Telegram分流 | Telegram分流 | ✅ 一致 |
| google.com | Google | Google | ✅ 一致 |
| qq.com | DIRECT | direct | ✅ 一致 |
| doubleclick.net | REJECT | block | ✅ 一致 |
| example.com | 节点选择 | 节点选择 | ✅ 一致 |

## 说明
- 这是离线小样本对照，用于快速验证转换方向。
- 线上最终命中仍以运行时远程规则集下载结果为准。
