/**
 * seq-guard.js —— 「只认最新一次异步结果」的最小工具（2026-11-02）
 *
 * 背景：弹窗可切换对象（点开 A 的详情 → 未等响应就点开 B）。若先发出的请求后返回，
 * 会把 A 的数据写进 B 的界面（用户看到「B 的名字 + A 的资料」）。原实现 await 后直接赋值，没有校验。
 *
 * 抽成独立模块的理由：这段逻辑与 Vue 无关，抽出来后可以**直接测**，
 * 不必为了测它去挂载一个依赖 6 个组件的整套模板（实测挂载成本高且脆）。
 *
 * 用法：
 *   const guard = createSeqGuard();
 *   async function load() {
 *     const rec = guard.begin(key);      // 记录本次请求
 *     const data = await fetchSomething();
 *     if (!guard.isCurrent(rec)) return; // 过期 ⇒ 丢弃，不动任何状态
 *     apply(data);
 *   }
 *
 * isCurrent 同时校验「序号」与「业务键」：
 *   - 序号：挡住同一对象的多次请求乱序（重试/刷新）；
 *   - 业务键：挡住「对象已切换」（如 userId 变了），即使序号恰好相同也不会误判。
 */

/** @returns {{ begin: (key?: string) => {seq: number, key: string}, isCurrent: (rec: any) => boolean, current: () => number }} */
export function createSeqGuard() {
  let seq = 0;
  let lastKey = '';
  return {
    begin(key = '') {
      seq += 1;
      lastKey = String(key);
      return { seq, key: lastKey };
    },
    /** 只认最新一次 begin 的那个请求（且业务键未变） */
    isCurrent(rec) {
      if (!rec) return false;
      return rec.seq === seq && String(rec.key) === lastKey;
    },
    current() { return seq; },
  };
}

export default createSeqGuard;
