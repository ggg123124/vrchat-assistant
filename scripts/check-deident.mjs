#!/usr/bin/env node
/**
 * check-deident.mjs — 去标识化判据（issue #308 §3）
 *
 * 两条轨：
 *   (a) ID 轨（确定性）：工作树里的 `usr_` 用户标识必须是统一占位模板，出现 v4 形态即失败。
 *       只约束 `usr_`（个人用户标识）。`wrld_` 是世界内容的公开 ID，测试里用真实公开世界 ID
 *       做功能性夹具（如 The Great Pug），不属于个人数据，纳入会让判据在存量上恒红。
 *   (b) 昵称轨（不落明文）：昵称 token 只从环境变量 / 未跟踪文件读取，脚本内不内嵌。
 *       未提供 token 时输出 skipped（退出码 0），绝不输出 pass。
 *
 * 退出码：pass = 0；skipped = 0（报告里显式计数）；fail = 1。
 * 归一化：比较前只去掉行尾 CR，不折叠空白、不做大小写变换。
 * 范围：只约束工作树（git 历史不重写），只看源码文本，不扫描运行期生成值。
 *
 * 用法：
 *   node scripts/check-deident.mjs [--root <dir>] [--json]
 *   VRC_DEIDENT_TOKENS="昵称1,昵称2" node scripts/check-deident.mjs
 *   VRC_DEIDENT_TOKENS_FILE=/path/to/tokens.txt node scripts/check-deident.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** 统一占位模板（与 #306 定稿一致；自身是 v4 形态，必须在白名单里） */
export const PLACEHOLDER_USR = 'usr_01234567-0123-4123-8123-0123456789ab';

/** v4 形态的用户 ID：版本位 4、变体位 [89ab] */
const USR_V4_RE = /usr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/** 显式白名单：只允许统一占位模板本身 */
const ID_WHITELIST = new Set([PLACEHOLDER_USR.toLowerCase()]);

/** 中文/字母数字边界：避免把「好友A一起」误判成 token「好友A」 */
function hasBoundary(text, index, token) {
  const before = index > 0 ? text[index - 1] : '';
  const after = index + token.length < text.length ? text[index + token.length] : '';
  const isWord = (ch) => /[A-Za-z0-9_]/.test(ch) || /[\u4e00-\u9fff]/.test(ch);
  if (before && isWord(before)) return false;
  if (after && isWord(after)) return false;
  return true;
}

/** 去掉行尾 CR（唯一归一化） */
export function normalizeLine(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 从 git 索引枚举工作树文本文件（排除未跟踪文件，token 文件天然不会被扫到） */
export function listTrackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

function readTextFile(absPath) {
  const buf = fs.readFileSync(absPath);
  // 二进制文件（含 NUL）跳过：只看源码文本
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}

function scanIdTrack(files, root) {
  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    const text = readTextFile(path.join(root, rel));
    if (text === null) continue;
    scanned += 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = normalizeLine(lines[i]);
      for (const m of line.matchAll(USR_V4_RE)) {
        if (ID_WHITELIST.has(m[0].toLowerCase())) continue;
        findings.push({ track: 'id', file: rel, line: i + 1, value: m[0] });
      }
    }
  }
  return { scanned, findings };
}

function scanNicknameTrack(files, root, tokens) {
  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    const text = readTextFile(path.join(root, rel));
    if (text === null) continue;
    scanned += 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = normalizeLine(lines[i]);
      for (const token of tokens) {
        if (!token) continue;
        let from = 0;
        for (;;) {
          const idx = line.indexOf(token, from);
          if (idx === -1) break;
          if (hasBoundary(line, idx, token)) {
            findings.push({ track: 'nickname', file: rel, line: i + 1, value: token });
          }
          from = idx + token.length;
        }
      }
    }
  }
  return { scanned, findings };
}

/** 解析昵称 token：环境变量（逗号/换行分隔）优先，其次 token 文件（每行一个，# 开头为注释） */
export function readTokens(env = process.env) {
  const inline = String(env.VRC_DEIDENT_TOKENS || '').trim();
  if (inline) {
    return inline.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  }
  const file = String(env.VRC_DEIDENT_TOKENS_FILE || '').trim();
  if (file) {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').map(normalizeLine).map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }
  return [];
}

/**
 * 执行判据。
 * @param {{root?: string, files?: string[], tokens?: string[]}} opts
 * @returns {{status: 'pass'|'fail'|'skipped', idFindings: object[], nicknameFindings: object[],
 *            idScanned: number, nicknameScanned: number, skipped: {nickname: boolean}}}
 */
export function runCheck({ root = process.cwd(), files, tokens = [] } = {}) {
  const list = files || listTrackedFiles(root);
  const id = scanIdTrack(list, root);
  const nicknameSkipped = tokens.length === 0;
  const nick = nicknameSkipped
    ? { scanned: 0, findings: [] }
    : scanNicknameTrack(list, root, tokens);
  const fail = id.findings.length > 0 || nick.findings.length > 0;
  return {
    status: fail ? 'fail' : (nicknameSkipped ? 'skipped' : 'pass'),
    idFindings: id.findings,
    nicknameFindings: nick.findings,
    idScanned: id.scanned,
    nicknameScanned: nick.scanned,
    skipped: { nickname: nicknameSkipped },
  };
}

export function formatReport(result) {
  const lines = [];
  lines.push(`[deident] ID 轨：扫描 ${result.idScanned} 个文本文件，${result.idFindings.length} 处命中（白名单占位模板 1 个）`);
  if (result.skipped.nickname) {
    lines.push('[deident] 昵称轨：skipped（未提供 token）');
  } else {
    lines.push(`[deident] 昵称轨：扫描 ${result.nicknameScanned} 个文本文件，${result.nicknameFindings.length} 处命中`);
  }
  for (const f of [...result.idFindings, ...result.nicknameFindings]) {
    lines.push(`[deident] ✗ ${f.file}:${f.line}  ${f.value}`);
  }
  const skipped = result.skipped.nickname ? 1 : 0;
  const verdict = result.status === 'fail' ? 'FAIL' : (result.status === 'skipped' ? 'SKIPPED' : 'PASS');
  lines.push(`[deident] 结果：${verdict}（${result.idFindings.length + result.nicknameFindings.length} 处失败；${skipped} 项 skipped${skipped ? '（昵称轨：未提供 token）' : ''}）`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) { root = path.resolve(args[++i]); }
    else if (args[i] === '--json') { json = true; }
  }
  const tokens = readTokens();
  const result = runCheck({ root, tokens });
  if (json) {
    process.stdout.write(JSON.stringify({ ...result, status: result.status, tokenCount: tokens.length }, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(result) + '\n');
  }
  process.exit(result.status === 'fail' ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
