// @vitest-environment happy-dom
/**
 * auth-hard-timeout.test.js —— 鉴权探测必须有与 fetch 无关的硬超时（2026-11-02）
 *
 * 用户报「卡在正在检查访问鉴权」。verifyToken / probeAuthRequired 都带 AbortSignal.timeout，
 * 但**部分环境会忽略该 signal**（旧内核 / fetch 被 polyfill / SW 拦截）⇒ await 永不返回
 * ⇒ finally 永不执行 ⇒ 界面永久停在检查态，用户完全无从判断。
 *
 * 本用例断言的是**源码契约**（App.vue 里存在独立计时器 + finally 走统一收口），
 * 因为挂载整个 App 需要一整套 PrimeVue 桩，代价远大于收益（此前已踩过）。
 * 变异：删掉硬超时那段 ⇒ 必须红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, 'App.vue'), 'utf8');

describe('鉴权检查态必须有硬超时兜底', () => {
  it('存在独立于 fetch 的计时器', () => {
    expect(src).toMatch(/AUTH_HARD_TIMEOUT_MS/);
    expect(src).toMatch(/setTimeout\(/);
  });

  it('超时后会把 authChecking 置为 false', () => {
    // 在硬超时回调里必须关闭检查态
    const idx = src.indexOf('hardTimeout = setTimeout');
    expect(idx).toBeGreaterThan(0);
    const tail = src.slice(idx, idx + 600);
    expect(tail).toMatch(/authChecking\.value = false|finishChecking\(\)/);
  });

  it('finally 与硬超时共用同一收口，避免互相覆盖', () => {
    expect(src).toMatch(/finishChecking\(\)/);
    expect(src).toMatch(/const alreadyDone = finishChecking\(\)/);
  });

  it('超时后保留登录门并给出可读原因（不是静默白屏）', () => {
    const idx = src.indexOf('硬超时');
    expect(idx).toBeGreaterThan(-1);
    // 复审 💡4：原断言写成 /连接鉴权服务超时/，只命中了第 129 行的**注释**，
    // 真正赋给 loginReason 的文案是「鉴权服务响应较慢…」⇒ 那条断言是空转的。
    // 现在断言真正出现在赋值语句里的文案。
    expect(src).toMatch(/loginReason\.value = '[^']*鉴权服务响应较慢/);
  });
});


describe('硬超时不得武断判定鉴权失败（2026-11-02 实测教训）', () => {
  it('硬超时窗口必须大于 verifyToken 自身的超时（否则慢请求被误杀）', () => {
    const m = src.match(/AUTH_HARD_TIMEOUT_MS = (\d+)/);
    expect(m, 'AUTH_HARD_TIMEOUT_MS 应存在').toBeTruthy();
    const hardMs = Number(m[1]);
    // verifyToken 的默认超时是 20000ms（见 api.js）
    expect(hardMs).toBeGreaterThan(20000);
  });

  it('超时文案不得写成「失败/出错」，应说明会继续等待', () => {
    const idx = src.indexOf('硬超时只负责');
    expect(idx).toBeGreaterThan(-1);
    const chunk = src.slice(idx, idx + 500);
    expect(chunk).toMatch(/不武断判定鉴权失败/);
    // 必须说明请求仍在进行/会自动进入
    expect(chunk).toMatch(/请求仍在进行|自动进入面板/);
  });

  it('finally 在超时后仍会启动数据面（迟到的成功也要进面板）', () => {
    const i = src.indexOf('} finally {');
    expect(i).toBeGreaterThan(-1);
    const tail = src.slice(i, i + 600);
    expect(tail).toMatch(/if \(!loginView\.value\) startDashboard\(\)/);
  });
});
