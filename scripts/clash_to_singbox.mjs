#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const inFile = process.argv[2] || '/tmp/clash-generic-template/clash-template.json';
const outFile = process.argv[3] || 'experimental/singbox/singbox-template.json';

function readJSON(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}


function mapGeositeToRuleSetTag(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  // use custom remote rule-set tags to avoid deprecated geosite field
  return `geosite-${n}`;
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
    const tag = mapGeositeToRuleSetTag(p[1]);
    if (!tag) return null;
    return { action: 'route', rule_set: [tag], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'IP-CIDR' && p.length >= 3) {
    return { action: 'route', ip_cidr: [p[1]], outbound: mapOutboundTarget(p[2]) };
  }
  if (k === 'MATCH' && p.length >= 2) {
    return { action: 'route', outbound: mapOutboundTarget(p[1]) };
  }
  return { action: 'route', outbound: '节点选择', 'x-openclaw-unparsed': s };
}

function mapRuleProviderToSingboxSrs(url) {
  const u = String(url || '');
  // Clash YAML -> SingBox srs
  // e.g. /rule/Clash/Advertising/Advertising_Classical.yaml -> /rule/SingBox/Advertising/Advertising.srs
  if (!u.includes('/rule/Clash/')) return null;
  let out = u.replace('/rule/Clash/', '/rule/SingBox/');
  out = out
    .replace('Advertising_Classical.yaml', 'Advertising.srs')
    .replace('ChinaMax_Classical.yaml', 'ChinaMax.srs')
    .replace('Global_Classical.yaml', 'Global.srs')
    .replace(/\.yaml$/i, '.srs');
  return out;
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
    let outs = (Array.isArray(g?.proxies) ? g.proxies : []).map(mapOutboundTarget).filter(Boolean);
    if (!outs.length) outs = ['direct'];

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

  const rule_set = Object.entries(providers).map(([tag, v]) => {
    const rawUrl = String(v?.url || '');
    const mapped = mapRuleProviderToSingboxSrs(rawUrl);
    if (mapped) {
      return {
        tag,
        type: 'remote',
        format: 'binary',
        url: mapped,
        update_interval: '1d'
      };
    }
    return {
      tag,
      type: 'remote',
      format: 'source',
      url: rawUrl,
      update_interval: '1d'
    };
  }).filter(x => x.url);


  const geositeNames = [];
  for (const r of rules) {
    const t = String(r || '').trim();
    const p = t.split(',').map(x => x.trim());
    if ((p[0] || '').toUpperCase() === 'GEOSITE' && p[1]) geositeNames.push(p[1]);
  }
  const geositeSet = [...new Set(geositeNames)];
  const geositeRuleSets = geositeSet.map(name => ({
    tag: mapGeositeToRuleSetTag(name),
    type: 'remote',
    format: 'binary',
    url: `https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/${name}.srs`,
    update_interval: '1d'
  }));

  const routeRules = rules.map(parseRule).filter(Boolean);


  return {
    log: { level: 'info' },
    dns: {
      servers: [
        { tag: 'dns-remote', address: 'https://1.1.1.1/dns-query', detour: '节点选择' },
        { tag: 'dns-direct', address: '223.5.5.5', detour: 'direct' }
      ],
      rules: [
        {
          domain_suffix: ['zzao.de', 'fengqi0216.top'],
          server: 'dns-direct'
        },
        { rule_set: ['geosite-cn'], server: 'dns-direct' }
      ]
    },
    inbounds: [
      { type: 'mixed', tag: 'mixed-in', listen: '0.0.0.0', listen_port: 7890 }
    ],
    outbounds,
    route: {
      auto_detect_interface: true,
      rule_set: [...rule_set, ...geositeRuleSets],
      rules: routeRules,
      final: '节点选择'
    },
    experimental: {
      clash_api: {
        external_controller: '127.0.0.1:9090'
      }
    }
  };
}

const src = readJSON(inFile);
const out = convert(src);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(`generated: ${outFile}`);
