/**
 * test/status-sync-sep-normalize.test.mjs —— 分隔符/模板被 VRChat 规范化后的幂等性
 *
 * 2026-10-17 用户报障：自己的动态状态越长越多（「afk ｜11在线好友 ｜9在线好友 …」）。
 * 根因：VRChat 把半角 | 规范化成全角 ｜（实测：PUT "sleep |5在线好友" → 读回 "sleep ｜5在线好友"），
 * 而剥离/比较按原始字符串做 ⇒ 认不出自己的后缀、每轮再追加一段；未变化判定也永远不等。
 *
 * 复审（nixi + EMeowAGENT）指出同类路径：①模板字面量里的 | 也没做等价；②~ 只在一侧归一；
 * ③「他人改写」检测仍是裸比较。本文件对四处都加护栏。
 *
 * 变异自证（实测）：把 escapeReEq 退化为 escapeRe ⇒ 用例 1/2/4/5 红；把 sameStatus 退回 a === b ⇒ 用例 3/5 红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStatusSync, stripSuffix, composeStatus, normalizeStatusText, sameStatus } from '../core/status-sync.js';

const TEMPLATE = '{gameOnline}在线好友';
const SEP = ' |';
const FW = '\uFF5C';   // VRChat 回推时把 | 换成的全角竖线
const asRemote = (s) => String(s).split('|').join(FW);

test('半角分隔符写出的后缀，被 VRChat 规范化成全角后仍能被剥离', () => {
  const ours = composeStatus('afk', '5在线好友', { separator: SEP });
  assert.equal(ours, 'afk |5在线好友');
  assert.equal(stripSuffix(asRemote(ours), TEMPLATE, SEP), 'afk');
});

test('历史上已经累加多段的状态，一次剥离就收敛回正文（自愈）', () => {
  const remote = asRemote('afk |11在线好友 |9在线好友 |8在线好友 |7在线好友');
  assert.equal(stripSuffix(remote, TEMPLATE, SEP), 'afk');
});

test('未变化判定按规范化比较：半角 target 与全角 remote 视为同一状态', () => {
  const target = composeStatus('sleep', '5在线好友', { separator: SEP });
  const remote = asRemote(target);
  assert.notEqual(target, remote);
  assert.ok(sameStatus(target, remote));
  assert.ok(!sameStatus(target, asRemote(composeStatus('sleep', '6在线好友', { separator: SEP }))));
});

test('模板字面量里带竖线时，被规范化后同样能认出自己的后缀（复审同类路径）', () => {
  const tpl = '{total}在线好友 |挂机';
  const sep = ' |';
  const ours = composeStatus('afk', '5在线好友 |挂机', { separator: sep });
  const remote = asRemote(ours);            // VRChat 把整段里的 | 都变全角
  assert.equal(stripSuffix(remote, tpl, sep), 'afk', '模板里的竖线也要按等价类匹配');
  // 多段累加同样要一次剥净
  assert.equal(stripSuffix(asRemote('afk |5在线好友 |挂机 |9在线好友 |挂机'), tpl, sep), 'afk');
});

test('引擎级：读回被规范化后，下一次同步判 unchanged、不再重复 PUT（复审 ⚠️3）', async () => {
  const state = { desc: 'afk', puts: [] };
  let nowMs = 1_000_000;
  const ctx = {
    storage: {
      getConfig: () => JSON.stringify({ enabled: true, mode: 'suffix', template: TEMPLATE, separator: SEP }),
      setConfig: () => {},
      query: () => [{ total: 5, web: 0, game: 5 }],
    },
    friendState: { getOnlineCount: () => 5 },
    api: {
      _request: async (m, _p, body) => {
        if (m === 'GET') return { status: 200, data: { id: 'usr_self', status: 'active', statusDescription: state.desc } };
        if (m === 'PUT') { state.puts.push(body.statusDescription); state.desc = asRemote(body.statusDescription); return { status: 200, data: {} }; }
        return { status: 404, data: {} };
      },
    },
  };
  const s = new DynamicStatusSync(ctx, { now: () => nowMs });
  const r1 = await s.sync();
  assert.equal(r1.action, 'synced');
  assert.equal(state.puts.length, 1);
  // 越过 65s 冷却后再同步一次：远端是我们自己写的（只是被规范化了）⇒ 必须判 unchanged，不能再 PUT
  nowMs += 70_000;
  const r2 = await s.sync();
  assert.equal(r2.action, 'skipped');
  assert.equal(r2.reason, 'unchanged', '读回被规范化不得被当成「变了」或「别人在打字」');
  assert.equal(state.puts.length, 1);
});
