/**
 * VRChat 好友监控系统 — API 请求限流器
 * 
 * VRChat API 限制约 30 次/分钟
 * 安全间隔：2.5 秒/次（约 24 次/分钟）
 * 
 * 支持：请求队列、自动等待、并发控制
 */
import { getLogger } from './logger.js';
import { recordOpsLog } from './ops-log.js';

const log = getLogger('limiter');

// 慢等待阈值（毫秒，代码常量不走 env）：等待超过该值才记一行 INFO
const SLOW_WAIT_MS = 1000;

// 慢等待日志聚合（issue #192）：按次回显的行数 ≈ 串行批刷新条数（每位好友一行），
// 与积压无关；改为「去抖窗口」聚合——窗口内无新等待才输出一行汇总，信息量反而增加
// （次数/累计/单次最长/队列峰值）。计数器 slowWaits/maxQueueLen 语义不变（/health 仍是即时真值）。
const SLOW_WAIT_IDLE_MS = 30000;      // 空闲窗口：最后一次慢等待后静默这么久才 flush
const SLOW_WAIT_MAX_SPAN_MS = 300000; // 最大跨度：持续饱和时窗口不断被重置，若无上限将永不输出（禁静默降级）

export class RateLimiter {
  constructor(options = {}) {
    this.minInterval = options.minInterval || 2600;  // 毫秒
    this.maxQueueSize = options.maxQueueSize || 50;
    // 任务级超时兜底：>0 时单个任务超过该时长即 reject，防止死任务锁死队列。
    // 默认 30000ms；taskTimeoutMs=0 表示关闭该兜底。
    this.taskTimeoutMs = options.taskTimeoutMs ?? 30000;
    this._lastCallTime = 0;
    this._queue = [];
    this._processing = false;
    this._totalCalls = 0;
    this._totalWaited = 0;
    this._queueFull = 0;       // 队列满被拒次数
    this._taskTimeouts = 0;    // 任务级超时次数
    this._slowWaits = 0;       // 等待 >1000ms 的次数（语义不变：每次慢等待都自增）
    // 聚合旋钮（构造参数；生产走默认值，测试可调小）。约束 idle ≤ maxSpan：
    // 若 maxSpan 反而更小，单次等待也会在 maxSpan 处被 flush 并标注「持续饱和」，文案失真 → 取两者较大值兜底。
    const idle = Number(options.slowWaitIdleMs) > 0 ? Number(options.slowWaitIdleMs) : SLOW_WAIT_IDLE_MS;
    const span = Number(options.slowWaitMaxSpanMs) > 0 ? Number(options.slowWaitMaxSpanMs) : SLOW_WAIT_MAX_SPAN_MS;
    this.slowWaitIdleMs = idle;
    this.slowWaitMaxSpanMs = Math.max(span, idle);
    this._slowAgg = null;      // 当前聚合桶
    this._slowAggTimer = null; // 去抖定时器（unref，不阻塞进程退出）
    this._maxQueueLen = 0;     // 队列长度峰值
  }

  /**
   * 执行一个限流请求
   * @param {Function} fn - 返回 Promise 的异步函数
   * @param {object} [opts] - 可选覆盖项
   * @param {number} [opts.taskTimeoutMs] - 单个任务超时（毫秒）。不传则用实例默认 taskTimeoutMs。
   *                                      聚合类任务（内部串行拉多子资源，如 get_weekly_report）可传更大值
   *                                      避免被默认 30s 误杀；传 0 表示该任务关闭超时兜底。
   * @returns {Promise<any>}
   */
  async execute(fn, opts = {}) {
    return new Promise((resolve, reject) => {
      if (this._queue.length >= this.maxQueueSize) {
        this._queueFull++;
        log.warn('限流队列已满，拒绝新任务');
        recordOpsLog('ops', 'warn', '限流队列已满，拒绝新任务');
        reject(new Error('Rate limiter queue full'));
        return;
      }
      // 任务级覆盖：显式传给本任务的超时优先于实例默认
      const taskTimeout = opts.taskTimeoutMs !== undefined
        ? opts.taskTimeoutMs
        : this.taskTimeoutMs;
      this._queue.push({ fn, resolve, reject, taskTimeout });
      if (this._queue.length > this._maxQueueLen) this._maxQueueLen = this._queue.length;
      this._processQueue();
    });
  }

  /**
   * 慢等待聚合（issue #192）：累积到桶里，按「去抖窗口」输出一行。
   * - 空闲窗口（默认 30s）内无新等待 → flush，文案标明跨度；
   * - 最大跨度（默认 5min）兜底 → 持续饱和时也定期输出，避免「窗口不断重置导致永不输出」；
   * - 定时器 unref()：短命进程/测试不被挂住；进程退出时未 flush 的桶随之丢弃（可接受，计数器仍在 /health）。
   */
  _accumulateSlowWait(waitTime, queueLen) {
    const now = Date.now();
    if (!this._slowAgg) {
      this._slowAgg = { count: 0, sumMs: 0, maxMs: 0, maxQueue: 0, firstAt: now };
    }
    const a = this._slowAgg;
    a.count += 1;
    a.sumMs += waitTime;
    if (waitTime > a.maxMs) a.maxMs = waitTime;
    if (queueLen > a.maxQueue) a.maxQueue = queueLen;
    if (now - a.firstAt >= this.slowWaitMaxSpanMs) {
      this._flushSlowWaitAgg('cap', now - a.firstAt);
      return;
    }
    if (this._slowAggTimer) clearTimeout(this._slowAggTimer);
    const timer = setTimeout(() => this._flushSlowWaitAgg('idle', this.slowWaitIdleMs), this.slowWaitIdleMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._slowAggTimer = timer;
  }

  /** 输出聚合结果（reason: 'idle' | 'cap' | 'manual'） */
  _flushSlowWaitAgg(reason = 'manual', spanMs = 0) {
    if (this._slowAggTimer) {
      clearTimeout(this._slowAggTimer);
      this._slowAggTimer = null;
    }
    const a = this._slowAgg;
    this._slowAgg = null;
    if (!a || a.count === 0) return;
    const secs = Math.max(1, Math.round(spanMs / 1000));
    const scope = reason === 'cap' ? `持续饱和 ≥${secs}s` : `近 ${secs}s 无新等待`;
    log.info(
      `限流等待聚合（${scope}）：${a.count} 次，累计 ${a.sumMs}ms，单次最长 ${a.maxMs}ms，队列峰值 ${a.maxQueue}`
    );
  }

  /** 立即输出未 flush 的聚合桶（供测试/优雅退出调用） */
  flushSlowWaitAgg() {
    this._flushSlowWaitAgg('manual', this._slowAgg ? Date.now() - this._slowAgg.firstAt : 0);
  }

  async _processQueue() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this._lastCallTime;
      const waitTime = Math.max(0, this.minInterval - elapsed);

      if (waitTime > 0) {
        this._totalWaited += waitTime;
        if (waitTime > SLOW_WAIT_MS) {
          this._slowWaits++;   // 计数即时（/health 的 slowWaits 不受聚合影响）
          this._accumulateSlowWait(waitTime, this._queue.length);
        }
        await new Promise(r => setTimeout(r, waitTime));
      }

      const item = this._queue.shift();
      this._lastCallTime = Date.now();
      this._totalCalls++;

      // 任务级超时兜底：即使 fn 内部死等（网络 socket 挂起、handler 逻辑卡死），
      // 也会在 item.taskTimeout（默认继承实例 taskTimeoutMs；可为负/0 表示关闭该兜底）
      // 后 reject，防止一个任务占住队头把整条队列锁死。
      // 若 fn 已自行设置了更短超时/先完成，此处兑现 Promise.race 即可，无副作用。
      // ⚠️ 超时仅 reject 调用方，不取消底层 fn——若被超时的是写操作，调用方重试可能重复执行，
      //    写操作调用方应在业务层自行处理幂等/重试语义。
      try {
        if (item.taskTimeout == null || item.taskTimeout > 0) {
          const budget = item.taskTimeout != null ? item.taskTimeout : this.taskTimeoutMs;
          let timer;
          const timeoutP = new Promise((_, rej) => {
            timer = setTimeout(() => {
              rej(new Error(`Rate limiter 任务超时 (${budget}ms)`));
            }, budget);
            // 进程退出时不因未清的 timer 而挂住
            if (typeof timer.unref === 'function') timer.unref();
          });
          const result = await Promise.race([item.fn(), timeoutP]);
          clearTimeout(timer); // fn 先完成则清掉闲置 timer，避免误导/残留
          item.resolve(result);
        } else {
          const result = await item.fn();
          item.resolve(result);
        }
      } catch (err) {
        if (err && /任务超时/.test(err.message)) {
          this._taskTimeouts++;
          log.warn(`[限流] ${err.message}`);
          recordOpsLog('ops', 'warn', `限流任务超时：${err.message}`);
        }
        item.reject(err);
      }
    }

    this._processing = false;
  }

  /** 获取统计 */
  getStats() {
    return {
      totalCalls: this._totalCalls,
      totalWaitedMs: this._totalWaited,
      queueLength: this._queue.length,
      isProcessing: this._processing,
      minInterval: this.minInterval,
      queueFull: this._queueFull,
      taskTimeouts: this._taskTimeouts,
      slowWaits: this._slowWaits,
      maxQueueLen: this._maxQueueLen,
    };
  }

  /** 重置统计 */
  resetStats() {
    this._totalCalls = 0;
    this._totalWaited = 0;
    this._queueFull = 0;
    this._taskTimeouts = 0;
    this._slowWaits = 0;
    this._maxQueueLen = 0;
  }
}
