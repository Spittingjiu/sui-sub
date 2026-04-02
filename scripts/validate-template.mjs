#!/usr/bin/env node
import fs from 'node:fs';
import YAML from 'js-yaml';

const p = process.argv[2] || 'template.yaml';
if (!fs.existsSync(p)) {
  console.error(`template not found: ${p}`);
  process.exit(1);
}

let obj;
try {
  obj = YAML.load(fs.readFileSync(p, 'utf8'));
} catch (e) {
  console.error('invalid yaml:', e.message);
  process.exit(1);
}

const groups = Array.isArray(obj?.['proxy-groups']) ? obj['proxy-groups'] : [];
const rules = Array.isArray(obj?.rules) ? obj.rules : [];
const groupNames = new Set(groups.map(g => String(g?.name || '').trim()).filter(Boolean));

const missing = [];
for (const r of rules) {
  const s = String(r || '');
  if (!s.startsWith('RULE-SET,')) continue;
  const parts = s.split(',');
  if (parts.length < 3) continue;
  const target = parts[2]?.trim();
  if (!target) continue;
  if (['DIRECT', 'REJECT', 'MATCH'].includes(target.toUpperCase())) continue;
  if (!groupNames.has(target)) missing.push({ rule: s, target });
}

if (missing.length) {
  console.error('rule target group missing:');
  for (const m of missing) console.error(`- ${m.target} <= ${m.rule}`);
  process.exit(2);
}

console.log('yaml template validate ok');
