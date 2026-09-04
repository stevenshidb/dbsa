import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** 简单解析 .env（KEY=VALUE），不覆盖已有 process.env。 */
export function loadEnv(file = resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return {};
  const parsed = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) parsed[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return parsed;
}

export function requireEnv(name, optional = false) {
  const value = process.env[name];
  if (!value && !optional) {
    console.error(`缺少环境变量 ${name}（可复制 .env.example 为 .env 后填写）`);
    process.exit(1);
  }
  return value ?? '';
}
