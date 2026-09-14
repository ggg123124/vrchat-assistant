/**
 * test/test-logger-systemd.test.mjs — core/logger.js 的 systemd/journald 协同单元测试
 *
 * 覆盖：
 *   1. VRC_MONITOR_LOGGER_SYSLOG_PREFIX=1：stdout 行前缀 `<N>`（RFC 5424 优先级），
 *      使 systemd 的 SyslogLevelPrefix= 解析出 journald PRIORITY；
 *   2. 文件输出永不带 `<N>` 前缀（前缀只走 stdout，避免污染文件解析）；
 *   3. VRC_MONITOR_LOGGER_FILE=0：关闭文件落盘（不建目录、不写 monitor.log），
 *      stdout 仍保留（开发规范 §3.8「stdout 永远保留」）；
 *   4. getLoggerInfo()：/health 暴露用的只读配置快照。
 *
 * 自包含：显式临时目录 + 显式 initLogger 选项，不碰生产日志目录。
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { initLogger, getLogger, getLoggerInfo } =
  await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);

const rundir = path.join(__dirname, 'logger-systemd-test-rundir');

// console 捕获：writeToConsole 走 console.{debug,info,warn,error}
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

before(() => {
  rmSync(rundir, { recursive: true, force: true });
  mkdirSync(rundir, { recursive: true });
});
after(() => {
  restoreConsole();
  // 只清理本测试自建的临时目录。绝不动 <仓库>/logs —— 那是默认配置下**正在写**的生产
  // 日志目录（VRC_MONITOR_LOGGER_DIR 默认 <仓库>/logs），删它会误删线上日志。
  rmSync(rundir, { recursive: true, force: true });
});

beforeEach(() => captureConsole());
afterEach(() => restoreConsole());

test('syslogPrefix：stdout 行前缀为 RFC 5424 优先级（info=6 / warn=4 / error=3 / debug=7）', () => {
  const dir = path.join(rundir, 'prefix');
  initLogger({ dir, level: 'debug', format: 'text', console: true, file: false, syslogPrefix: true });
  const log = getLogger('t');
  log.info('info 行');
  log.warn('warn 行');
  log.error('error 行');
  log.debug('debug 行');

  assert.equal(captured.length, 4);
  assert.ok(captured[0].startsWith('<6>'), `info 应以 <6> 开头: ${captured[0]}`);
  assert.ok(captured[1].startsWith('<4>'), `warn 应以 <4> 开头: ${captured[1]}`);
  assert.ok(captured[2].startsWith('<3>'), `error 应以 <3> 开头: ${captured[2]}`);
  assert.ok(captured[3].startsWith('<7>'), `debug 应以 <7> 开头: ${captured[3]}`);
});

test('syslogPrefix 默认关闭：stdout 行不带 <N>', () => {
  const dir = path.join(rundir, 'noprefix');
  initLogger({ dir, level: 'debug', format: 'text', console: true, file: false, syslogPrefix: false });
  getLogger('t').info('无前缀');
  assert.equal(captured.length, 1);
  assert.ok(!captured[0].startsWith('<'), `默认不应有前缀: ${captured[0]}`);
  assert.ok(captured[0].includes('INFO'), '仍保留文本格式级别');
});

test('文件输出永不携带 <N> 前缀（前缀只走 stdout）', () => {
  const dir = path.join(rundir, 'prefixfile');
  initLogger({ dir, level: 'debug', format: 'text', console: true, file: true, syslogPrefix: true });
  getLogger('t').warn('落盘行');
  const file = path.join(dir, 'monitor.log');
  assert.ok(existsSync(file), '应写入 monitor.log');
  const line = readFileSync(file, 'utf8').trim();
  assert.ok(!line.startsWith('<'), `文件行不应有 <N> 前缀: ${line}`);
  assert.ok(line.includes('WARN'), '文件行保持文本格式');
  // 同时 console 侧带前缀
  assert.ok(captured[0].startsWith('<4>'));
});

test('VRC_MONITOR_LOGGER_FILE=0：不建目录/不写文件，stdout 仍在', () => {
  const dir = path.join(rundir, 'nofile');
  rmSync(dir, { recursive: true, force: true });
  initLogger({ dir, level: 'info', format: 'text', console: true, file: false, syslogPrefix: false });
  getLogger('t').info('仅 stdout');
  assert.ok(!existsSync(dir), '关闭文件输出时不应创建日志目录');
  assert.equal(captured.length, 1, 'stdout 仍应输出');
});

test('getLoggerInfo：只读快照反映当前配置', () => {
  const dir = path.join(rundir, 'info');
  initLogger({ dir, level: 'warn', format: 'json', console: true, file: true, syslogPrefix: true });
  const info = getLoggerInfo();
  assert.equal(info.level, 'warn');
  assert.equal(info.format, 'json');
  assert.equal(info.file, true);
  assert.equal(info.console, true);
  assert.equal(info.syslogPrefix, true);
  assert.equal(info.dir, path.resolve(dir));
  assert.equal(info.filePath, path.join(path.resolve(dir), 'monitor.log'));
});

test('getLoggerInfo：file=false 时 filePath 为空字符串', () => {
  initLogger({ dir: path.join(rundir, 'info2'), level: 'info', file: false, syslogPrefix: false });
  const info = getLoggerInfo();
  assert.equal(info.file, false);
  assert.equal(info.filePath, '');
});

test('getLoggerInfo：目录不可写降级时 file 报生效值 false（与空 filePath 不矛盾）', () => {
  // 用占位文件把父路径变成非目录 → mkdirSync 必然失败，走「降级为仅 console」分支
  const blocker = path.join(rundir, 'blocker-file');
  writeFileSync(blocker, '');
  initLogger({
    dir: path.join(blocker, 'logs'),
    level: 'info',
    format: 'text',
    console: false,
    file: true,
    syslogPrefix: false,
  });
  const info = getLoggerInfo();
  assert.equal(info.filePath, '');
  assert.equal(info.file, false, '降级后须报生效值 false，不能仍报配置的 true');
});
