// 路径 A 的双层安全之一：TiDB Cloud Lake 侧（LAKE_MCP_SAFE_MODE=true）。
// 只读语句可访问所有对象；写语句只允许命中当前会话 sandbox 前缀的对象。

import { randomBytes } from 'node:crypto';

export const SANDBOX_PREFIX = 'mcp_sandbox_';

export function newSessionId() {
  return randomBytes(4).toString('hex');
}

export function sandboxPrefix(sessionId) {
  return `${SANDBOX_PREFIX}${sessionId}_`;
}

/** 把“;”分隔的语句拆开，忽略空语句与末尾分号。 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let escape = false;
  for (const ch of String(sql)) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const READ_ONLY_PATTERN =
  /^(select\b|with\b|show\b|describe\b|desc\b|explain\b|list\s+@|use\b|set\b)/i;

const DANGEROUS_WRITE =
  /\b(insert\s+into|update\s+.*\bset\b|delete\s+from|drop\s+table|drop\s+database|drop\s+view|truncate\s+table|alter\s+table|merge\s+into|replace\s+into|copy\s+into|create\s+database|create\s+table|grant\b|revoke\b|call\s+\w+\s*\(|kill\b|set\s+role\b)/is;

export function checkSqlSafety(sql, { safeMode = true, prefix = '' } = {}) {
  if (!safeMode) return { allowed: true, reason: '' };
  const statements = splitStatements(sql);
  if (statements.length === 0) return { allowed: false, reason: '空 SQL' };
  for (const statement of statements) {
    if (READ_ONLY_PATTERN.test(statement)) continue;
    if (prefix && new RegExp(`\\b${prefix}[\\w]*`, 'i').test(statement)) {
      // 命中会话 sandbox 前缀时放行（仍建议由数据库权限做最后一道防线）。
      continue;
    }
    if (DANGEROUS_WRITE.test(statement)) {
      return {
        allowed: false,
        reason: `安全模式阻止了写/危险操作，且对象不在当前 sandbox（${prefix || 'mcp_sandbox_*'}）：${statement.slice(0, 120)}`,
      };
    }
    return {
      allowed: false,
      reason: `安全模式只允许 SELECT/SHOW/DESCRIBE/EXPLAIN/LIST 或 sandbox 前缀对象，已拦截：${statement.slice(0, 120)}`,
    };
  }
  return { allowed: true, reason: '' };
}
