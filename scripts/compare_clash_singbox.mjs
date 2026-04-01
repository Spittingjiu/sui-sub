#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const clashFile = process.argv[2] || '/tmp/clash-generic-template/clash-template.json';
const singFile = process.argv[3] || 'experimental/singbox/singbox-template.json';
const outFile = process.argv[4] || 'experimental/singbox/match-report.md';

const clash = JSON.parse(fs.readFileSync(clashFile, 'utf8'));
const sing = JSON.parse(fs.readFileSync(singFile, 'utf8'));

const clashRules = Array.isArray(clash.rules) ? clash.rules : [];
const singRules = (sing.route && Array.isArray(sing.route.rules)) ? sing.route.rules : [];

// 小样本命中集（用于离线近似对照 RULE-SET）
const rsDomainMap = {
  my_whitelist: ['music.qq.com', 'www.anyrouter.top', 'riotgames.com'],
  openai: ['openai.com', 'api.openai.com'],
  anthropic: ['claude.ai', 'api.anthropic.com'],
  youtube: ['youtube.com', 'ytimg.com'],
  telegram: ['t.me', 'telegram.org'],
  google: ['google.com', 'gstatic.com'],
  direct: ['qq.com', 'baidu.com', 'bilibili.com'],
  proxy: ['example.net'],
  reject: ['doubleclick.net']
};


function normTarget(x) {
  const t = String(x || '').trim();
  const u = t.toUpperCase();
  if (u === 'DIRECT' || u === 'direct'.toUpperCase()) return 'DIRECT';
  if (u === 'REJECT' || u === 'BLOCK') return 'REJECT';
  return t;
}

const samples = [
  'music.qq.com',
  'www.anyrouter.top',
  'riotgames.com',
  'openai.com',
  'claude.ai',
  'youtube.com',
  't.me',
  'google.com',
  'qq.com',
  'doubleclick.net',
  'example.com'
];

function byRuleSetTag(domain, tag) {
  const arr = rsDomainMap[String(tag || '').trim()] || [];
  return arr.some(d => domain === d || domain.endsWith('.' + d));
}

function clashMatch(domain) {
  for (const r of clashRules) {
    const p = String(r || '').split(',').map(x => x.trim());
    const k = (p[0] || '').toUpperCase();
    if (k === 'DOMAIN' && domain === p[1]) return p[2] || '';
    if (k === 'DOMAIN-SUFFIX' && (domain === p[1] || domain.endsWith('.' + p[1]))) return p[2] || '';
    if (k === 'DOMAIN-KEYWORD' && domain.includes(p[1])) return p[2] || '';
    if (k === 'RULE-SET' && byRuleSetTag(domain, p[1])) return p[2] || '';
    if (k === 'MATCH') return p[1] || '';
  }
  return '';
}

function singMatch(domain) {
  for (const r of singRules) {
    const out = r.outbound || '';
    const ds = r.domain || [];
    const dss = r.domain_suffix || [];
    const dks = r.domain_keyword || [];
    const rs = r.rule_set || [];

    if (ds.includes(domain)) return out;
    for (const s of dss) if (domain === s || domain.endsWith('.' + s)) return out;
    for (const k of dks) if (domain.includes(k)) return out;
    for (const tag of rs) {
      const t = String(tag || '').replace(/^geosite-/, '');
      if (byRuleSetTag(domain, t)) return out;
    }
  }
  return sing?.route?.final || '';
}

let md = '# Clash vs sing-box 分流命中对照\n\n';
md += `- Clash 模板: ${clashFile}\n`;
md += `- sing-box 模板: ${singFile}\n\n`;
md += '| 域名 | Clash 命中 | sing-box 命中 | 结论 |\n';
md += '|---|---|---|---|\n';

for (const d of samples) {
  const c = clashMatch(d) || '(未命中)';
  const s = singMatch(d) || '(未命中)';
  const ok = normTarget(c) === normTarget(s) ? '✅ 一致' : '❌ 不一致';
  md += `| ${d} | ${c} | ${s} | ${ok} |\n`;
}

md += '\n## 说明\n';
md += '- 这是离线小样本对照，用于快速验证转换方向。\n';
md += '- 线上最终命中仍以运行时远程规则集下载结果为准。\n';

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, md);
console.log(`written: ${outFile}`);
