#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const inFile = process.argv[2] || '/tmp/clash-generic-template/clash-template.json';
const outFile = process.argv[3] || 'experimental/singbox/singbox-template.json';

function readJSON(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function mapOutboundTarget(t) {
  const x = String(t || '').trim();
  if (!x) return '节点选择';
  if (x.toUpperCase() === 'DIRECT') return 'direct';
  if (x.toUpperCase() === 'REJECT') return 'block';
  return x;
}

function parseRule(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  const p = s.split(',').map(x => x.trim());
  const k = (p[0] || '').toUpperCase();

  if (k === 'RULE-SET' && p.length >= 3) {
    return { action: 'route', rule_set: [p[1]], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'DOMAIN-SUFFIX' && p.length >= 3) {
    return { action: 'route', domain_suffix: [p[1]], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'DOMAIN' && p.length >= 3) {
    return { action: 'route', domain: [p[1]], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'DOMAIN-KEYWORD' && p.length >= 3) {
    return { action: 'route', domain_keyword: [p[1]], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'GEOSITE' && p.length >= 3) {
    return { action: 'route', geosite: [p[1]], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'IP-CIDR' && p.length >= 3) {
    return { action: 'route', ip_cidr: [p[1]], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'MATCH' && p.length >= 2) {
    return { action: 'route', outbound: mapOutboundTarget(p[1]) };
  }
  return { action: 'route', outbound: '节点选择', 'x-openclaw-unparsed': s };
}

function toDuration(v, fallback = '600s') {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return `${Math.floor(n)}s`;
}

function convert(template) {
  const groups = Array.isArray(template['proxy-groups']) ? template['proxy-groups'] : [];
  const rules = Array.isArray(template.rules) ? template.rules : [];
  const providers = template['rule-providers'] || {};

  const outbounds = [
    { type: 'direct', tag: 'direct' },
    { type: 'block', tag: 'block' }
  ];

  for (const g of groups) {
    const type = String(g?.type || '').toLowerCase();
    const tag = String(g?.name || '').trim();
    if (!tag) continue;
    const outs = (Array.isArray(g?.proxies) ? g.proxies : []).map(mapOutboundTarget).filter(Boolean);

    if (type === 'url-test' || type === 'urltest') {
      outbounds.push({
        type: 'urltest',
        tag,
        outbounds: outs,
        url: String(g?.url || 'https://cp.cloudflare.com/generate_204'),
        interval: toDuration(g?.interval, '600s'),
        tolerance: Number.isFinite(Number(g?.tolerance)) ? Number(g.tolerance) : 100
      });
    } else {
      outbounds.push({
        type: 'selector',
        tag,
        outbounds: outs,
        default: outs[0] || undefined
      });
    }
  }

  const rule_set = Object.entries(providers).map(([tag, v]) => ({
    tag,
    type: 'remote',
    format: 'source',
    url: String(v?.url || ''),
    update_interval: '1d'
  })).filter(x => x.url);

  const routeRules = rules.map(parseRule).filter(Boolean);

  return {
    log: { level: 'info' },
    dns: {
      servers: [
        { tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: '节点选择' },
        { tag: 'dns-direct', address: 'https://dns.alidns.com/dns-query', detour: 'direct' }
      ],
      rules: [
        { geosite: ['cn'], server: 'dns-direct' },
        { server: 'dns-remote' }
      ]
    },
    inbounds: [
      { type: 'mixed', tag: 'mixed-in', listen: '0.0.0.0', listen_port: 7890 }
    ],
    outbounds,
    route: {
      auto_detect_interface: true,
      rule_set,
      rules: routeRules,
      final: '节点选择'
    },
    experimental: {
      clash_api: {
        external_controller: '127.0.0.1:9090'
      }
    },
    'x-openclaw-note': 'Generated from Clash template for split-routing migration. Keep existing Clash business unchanged.'
  };
}

const src = readJSON(inFile);
const out = convert(src);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`generated: ${outFile}`);
