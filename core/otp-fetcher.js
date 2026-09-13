/**
 * OTP 邮箱获取 — 调用 fetch-otp.py 从邮箱提取 VRChat 验证码
 *
 * 留痕（外部调用可观测性）：IMAP 拉取是认证链路关键环节，失败必须可见——
 * 失败 → WARN + ops_log(kind='ext')，成功 → debug（>2000ms 升 INFO）。
 * ⚠️ 脱敏：执行命令含 imap 授权码，**原错误对象/命令原文绝不外泄**——catch 里只报
 * 「超时 / exit N」这类原因，并用同文案的新 Error 重新抛出（原 error.message 可能含授权码）。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ctx } from './server-context.js';
import { logExtFailure, logExtSuccess } from './ext-log.js';

export async function fetchOtpFromEmail() {
  const { __dirname, CRED_FILE } = ctx.paths;
  const otpScript = path.join(__dirname, 'scripts', 'fetch-otp.py');
  if (!existsSync(otpScript)) {
    throw new Error('fetch-otp.py 不存在');
  }
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const { execSync } = await import('node:child_process');
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  const pythonBin = process.env.VRC_MONITOR_PYTHON || 'python';
  let cmd = `"${pythonBin}" "${otpScript}" "${creds.email}" "${authCode}"`;
  if (creds.imap_host) cmd += ` "${creds.imap_host}"`;
  const startedAt = Date.now();
  let otp;
  try {
    otp = execSync(cmd, { timeout: 15000, encoding: 'utf-8' }).trim();
  } catch (err) {
    const signal = err && (err.signal || (err.killed ? 'SIGTERM' : ''));
    const isTimeout =
      signal === 'SIGTERM' ||
      /ETIMEDOUT|timeout|timed?\s*out/i.test(String((err && err.message) || ''));
    const reason = isTimeout
      ? 'IMAP 拉取超时（15000ms 未返回）'
      : `IMAP 拉取失败（${err && err.status !== undefined ? `exit ${err.status}` : '未知原因'}）`;
    logExtFailure('IMAP-OTP', '拉取 VRChat 邮箱验证码', reason, { durationMs: Date.now() - startedAt });
    // 重新抛出脱敏后的错误：原 err.message 含命令行（含授权码），不得向调用方/日志传播
    const safe = new Error(reason);
    safe.code = isTimeout ? 'OTP_FETCH_TIMEOUT' : 'OTP_FETCH_FAILED';
    throw safe;
  }
  logExtSuccess('IMAP-OTP', '拉取 VRChat 邮箱验证码', { durationMs: Date.now() - startedAt });
  return otp;
}
