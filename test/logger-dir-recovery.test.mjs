/**
 * test/logger-dir-recovery.test.mjs — 运行期日志目录被删除后的自愈 / 降级回归（issue #278）
 *
 * 覆盖：
 *   1. 运行期 `<日志目录>` 被外部删除 → 重建目录 + 同一行重试落盘（自愈），
 *      且 getLoggerInfo()（/health.logging 数据源）如实报 file: true + 非空 filePath；
 *   2. 连续失败未达阈值即恢复 → 不得降级（避免瞬时抖动清空文件日志）；
 *   3. 不可自愈的连续失败 → 同一失败段只输出一次错误（不逐行刷屏），达阈值后
 *      按启动期同语义降级为仅 console（file=false + filePath=''），stdout 仍保留。
 *
 * 自包含：显式临时目录 + 显式 initLogger 选项；**不触碰 <仓库>/logs**
 * （那是默认配置下正在写生产日志的目录，删它会误删线上日志）。
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { initLogger, getLogger, getLoggerInfo } =
  await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);

const rundir = path.join(__dirname, 'logger-recovery-test-rundir');

// console 捕获（logger 的 stdout 通道与文件写入失败提示都走 console.*）
const captured = [];
const orig = {};
const captureConsole = () => {
  captured.length = 0;
  for (const m of ['debug', 'info', 'warn', 'error']) {
    orig[m] = console[m];
    console[m] = (s) => captured.push(String(s));
  }
};
const restoreConsole = () => {
  for (const m of ['debug', 'info', 'warn', 'error']) {
    if (orig[m]) console[m] = orig[m];
  }
};
const countCaptured = (sub) => captured.filter((l) => l.includes(sub)).length;

/** 让 `<dir>` 变成「非目录」：删除后放一个同名占位文件（appendFileSync → ENOTDIR，mkdir → EEXIST，不可自愈） */
const replaceDirWithFile = (dir) => {
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, '');
};

before(() => {
  rmSync(rundir, { recursive: true, force: true });
  mkdirSync(rundir, { recursive: true });
});
after(() => {
  restoreConsole();
  rmSync(rundir, { recursive: true, force: true });
});
beforeEach(() => captureConsole());
afterEach(() => restoreConsole());

test('目录被外部删除 → 自愈：重建目录、同一行落盘、/health 如实报 file:true', () => {
  const dir = path.join(rundir, 'heal');
  initLogger({ dir, level: 'info', format: 'text', console: true, file: true, syslogPrefix: false });
  const log = getLogger('t');

  log.info('删除前的一行');
  rmSync(dir, { recursive: true, force: true });
  assert.ok(!existsSync(dir), '前置条件：目录已不存在');

  log.info('删除后的第一行');
  log.info('删除后的第二行');

  const file = path.join(dir, 'monitor.log');
  assert.ok(existsSync(file), '自愈：目录应被重建，monitor.log 应重新出现');
  const content = readFileSync(file, 'utf8');
  assert.ok(content.includes('删除后的第一行'), '删除后第一行应落盘');
  assert.ok(content.includes('删除后的第二行'), '删除后第二行应落盘');
  // 被删掉的旧文件内容不承诺恢复（数据已不在），此处只断言不再断档
  assert.ok(!content.includes('删除前的一行'), '旧文件已随目录删除，不承诺恢复历史内容');

  const info = getLoggerInfo();
  assert.equal(info.file, true, '自愈后 file 应为 true（生效值）');
  assert.equal(info.filePath, file, '自愈后 filePath 应保持原路径');
  assert.equal(countCaptured('写入日志文件失败'), 0, '自愈路径不得输出写入失败错误');
  assert.equal(countCaptured('日志目录已被外部删除，已重建'), 1, '重建须留一行非静默提示');
});

test('连续失败未达阈值即恢复 → 不降级（瞬时问题不得清空文件日志）', () => {
  const dir = path.join(rundir, 'transient');
  initLogger({ dir, level: 'info', format: 'text', console: true, file: true, syslogPrefix: false });
  const log = getLogger('t');

  log.info('正常一行');
  replaceDirWithFile(dir);
  log.info('失败一');   // 连续失败 1
  log.info('失败二');   // 连续失败 2（同一失败段，不再重复输出）

  rmSync(dir, { force: true }); // 恢复：删掉占位文件，目录缺失 → 下一次写入走自愈路径
  log.info('恢复后一行');

  const info = getLoggerInfo();
  assert.equal(info.file, true, '未达降级阈值不得清空文件输出');
  assert.equal(info.filePath, path.join(dir, 'monitor.log'), 'filePath 不得被清空');
  const content = readFileSync(path.join(dir, 'monitor.log'), 'utf8');
  assert.ok(content.includes('恢复后一行'), '恢复后应重新落盘');
  assert.equal(countCaptured('写入日志文件失败'), 1, '连续失败段内错误只输出一次');
  assert.equal(countCaptured('已降级为仅 console'), 0, '未达阈值不得输出降级提示');
});

test('不可自愈的连续失败 → 错误去重 + 达阈值降级为仅 console，stdout 仍保留', () => {
  const dir = path.join(rundir, 'degrade');
  initLogger({ dir, level: 'info', format: 'text', console: true, file: true, syslogPrefix: false });
  const log = getLogger('t');

  log.info('正常一行');
  replaceDirWithFile(dir);
  log.info('失败一');
  log.info('失败二');
  log.info('失败三'); // 第 3 次连续失败 → 达阈值降级

  const info = getLoggerInfo();
  assert.equal(info.file, false, '降级后 file 须报生效值 false（不得仍报配置的 true）');
  assert.equal(info.filePath, '', '降级后 filePath 应为空串（与 file:false 自洽，同启动期降级语义）');
  assert.equal(countCaptured('写入日志文件失败'), 1, '同一失败段只输出一次错误（不逐行刷屏）');
  assert.equal(countCaptured('已降级为仅 console'), 1, '降级应有一条明确提示（禁静默降级）');

  const before = captured.length;
  log.info('降级后一行');
  assert.equal(captured.length, before + 1, 'stdout 必须始终保留（开发规范 §3.8）');
  assert.equal(countCaptured('写入日志文件失败'), 1, '降级后不得再报写入失败');
});
