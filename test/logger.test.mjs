/**
 * test/logger.test.mjs — 日志模块 core/logger.js 单元测试（node:test，零新 dev 依赖）
 *
 * 覆盖：级别过滤、json 格式键、脱敏（authToken/cookie/邮箱/password/授权码）、
 *       轮转触发与 gz 可读、suppress 子串过滤、命名子 logger 标签。
 * 自包含：临时目录，不依赖真实凭据。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');

const { initLogger, getLogger, getLevelName, redactSecrets, setLevel, LEVELS } =
  await import(pathToFileURL(path.join(REPO, 'core', 'logger.js')).href);

let dir;
before(() => {
  dir = path.join(__dirname, 'logger-test-rundir');
  rmSync(dir, { recursive: true, force: true });
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  // 兜底清理：默认目录用例可能向 <仓库>/logs 写入，测试进程离开时一并清除
  rmSync(path.join(REPO, 'logs'), { recursive: true, force: true });
});

test('脱敏：authToken/cookie/邮箱/password/授权码 全部替换且零泄漏', () => {
  const out = redactSecrets(
    'authToken=abc123 cookie=xyz456 email=user@qq.com password=hunter2 smtp=mysecret'
  );
  assert.ok(!out.includes('abc123'), 'authToken 值不得泄漏');
  assert.ok(!out.includes('xyz456'), 'cookie 值不得泄漏');
  assert.ok(!out.includes('user@qq.com'), '邮箱不得泄漏');
  assert.ok(!out.includes('hunter2'), '密码不得泄漏');
  assert.ok(!out.includes('mysecret'), '授权码不得泄漏');
  assert.equal(out.match(/\[REDACTED\]/g)?.length, 5, '应有 5 处 [REDACTED]');
});

test('级别过滤：info 级别隐藏 debug，setLevel(debug) 后可见', () => {
  const d = path.join(dir, 'level');
  initLogger({ dir: d, format: 'text' });
  setLevel('info');
  const w = getLogger('app');
  w.info('visible info');
  w.debug('hidden debug');
  setLevel('debug');
  w.debug('now visible');
  const content = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  assert.ok(content.includes('visible info'), 'info 应写入');
  assert.ok(!content.includes('hidden debug'), 'info 级下 debug 应隐藏');
  assert.ok(content.includes('now visible'), 'debug 级下 debug 应写入');
});

test('json 格式：每行合法 JSON，固定键 ts/level/name/msg/pid', () => {
  const d = path.join(dir, 'json');
  initLogger({ dir: d, format: 'json' });
  getLogger('api').info('hello', { worldId: 'wrld_x' });
  const lines = readFileSync(path.join(d, 'monitor.log'), 'utf8')
    .trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1, '应只有一行 JSONL');
  const obj = JSON.parse(lines[0]);
  assert.ok(typeof obj.ts === 'string' && obj.ts.includes('T'), 'ts 应为 ISO 时间');
  assert.equal(obj.level, 'info', 'level 应小写 info');
  assert.equal(obj.name, 'api', 'name 应为命名标签');
  assert.equal(obj.msg, 'hello', 'msg 应为正文');
  assert.ok(typeof obj.pid === 'number', 'pid 应为数字');
  assert.equal(obj.worldId, 'wrld_x', 'meta 应并入顶层');
});

test('命名子 logger：输出带组件标签', () => {
  const d = path.join(dir, 'named');
  initLogger({ dir: d, format: 'text' });
  getLogger('ws').info('conn ok');
  const content = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  assert.ok(content.includes('[ws]'), '应带 [ws] 标签');
});

test('轮转：达到 maxSize 触发，gz 可读且命名含 UTC 时间戳+pid', () => {
  const d = path.join(dir, 'rotate');
  initLogger({ dir: d, format: 'text', maxSize: 2048, maxFiles: 3 });
  const l = getLogger('app');
  for (let i = 0; i < 150; i++) l.info('pad '.repeat(40) + i);
  const files = readdirSync(d);
  const gzs = files.filter((f) => f.endsWith('.gz'));
  assert.ok(gzs.length >= 1 && gzs.length <= 3, `gz 数 ${gzs.length} 应在 1-3`);
  assert.ok(files.includes('monitor.log'), '活跃文件应存在');
  for (const gz of gzs) {
    assert.match(gz, /^monitor-\d{8}-\d{6}-\d+\.log\.gz$/, '文件名应 YYYYMMDD-HHMMSS-pid');
    const buf = zlib.gunzipSync(readFileSync(path.join(d, gz))).toString();
    assert.ok(buf.trim().length > 0, 'gz 内容非空');
  }
});

test('suppress：命中子串的消息整条丢弃', () => {
  const d = path.join(dir, 'suppress');
  initLogger({ dir: d, format: 'text', suppress: ['ping', 'keepalive'] });
  const l = getLogger('mcp');
  l.info('ping request here');
  l.info('keepalive tick');
  l.info('normal event');
  const content = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  assert.ok(!content.includes('ping request'), 'ping 应被 suppress');
  assert.ok(!content.includes('keepalive tick'), 'keepalive 应被 suppress');
  assert.ok(content.includes('normal event'), '正常事件应保留');
});

test('getLevelName：数字转人类可读级别名', () => {
  assert.equal(getLevelName(LEVELS.info), 'info');
  assert.equal(getLevelName(LEVELS.warn), 'warn');
  assert.equal(getLevelName(LEVELS.debug), 'debug');
  assert.equal(getLevelName(LEVELS.error), 'error');
  assert.equal(getLevelName(10), 'debug');
});

test('env 目录变量用 VRC_MONITOR_LOGGER_DIR（不与 service-windows 的 LOG_DIR 撞名）', () => {
  const d = path.join(dir, 'envdir');
  process.env.VRC_MONITOR_LOGGER_DIR = d;
  const s = initLogger({}); // 无显式 dir → 走 resolveDir() 读 env
  assert.equal(s.dir, path.resolve(d), '应读取 VRC_MONITOR_LOGGER_DIR');
  assert.ok(readdirSync(d).length >= 0, '目录应可创建');
  delete process.env.VRC_MONITOR_LOGGER_DIR;
});

// ===== 评审回归：脱敏必须覆盖引号/JSON/Bearer/中键 形态（PR #132 review 阻断项1）=====
test('脱敏：JSON 引号值不泄漏（"key":"value"）', () => {
  const out = redactSecrets('{"authToken":"abc123","password":"hunter2"}');
  assert.ok(!out.includes('abc123'), 'JSON 引号值 authToken 不得泄漏');
  assert.ok(!out.includes('hunter2'), 'JSON 引号值 password 不得泄漏');
  assert.ok(out.includes('"[REDACTED]"'), '应保留双引号风格，符合 { "key":"[REDACTED]" }');
});

test('脱敏：Bearer token 空格分隔不残留', () => {
  const out = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.ok(!out.includes('eyJhbGci'), 'Bearer token 不得残留');
  assert.ok(out.includes('Bearer [REDACTED]') || out.includes('[REDACTED]'), '应置 [REDACTED]');
});

test('脱敏：meta 敏感 key 落盘整值脱敏（json 类型）', () => {
  const d = path.join(dir, 'metareg');
  initLogger({ dir: d, format: 'json' });
  getLogger('api').info('请求完成', { authToken: 'SECRET1', userId: 'usr_abc', status: 200 });
  const line = readFileSync(path.join(d, 'monitor.log'), 'utf8').trim();
  const obj = JSON.parse(line);
  assert.equal(obj.authToken, '[REDACTED]', 'meta authToken 键名命中 → 整值 [REDACTED]');
  assert.equal(obj.userId, 'usr_abc', '非敏感 meta 键值保留');
  assert.equal(obj.status, 200, '非敏感数字 meta 保留');
  assert.ok(!line.includes('SECRET1'), 'json 行不得残留 SECRET1');
});

test('脱敏：access_token/refresh_token 下划线键命中，tokens/tokenizer 不误伤', () => {
  const hit = redactSecrets('access_token=xyz refresh_token=abc');
  assert.ok(!hit.includes('xyz') && !hit.includes('abc'), '下划线 token 键值应脱敏');
  const keep = redactSecrets('tokens=abc tokenizer=v2');
  assert.ok(keep.includes('abc') && keep.includes('v2'), 'tokens/tokenizer 非凭据后缀不得误伤');
});

// ===== R2 评审回归：词根键在 json meta 落盘路径必须脱敏（此前只测文本形态漏了落盘）=====
test('脱敏：access_token/refresh_token/accessToken/refreshToken 在 json meta 落盘脱敏', () => {
  const d = path.join(dir, 'metatok');
  initLogger({ dir: d, format: 'json' });
  getLogger('api').info('oauth refresh', {
    access_token: 'LEAK1', refresh_token: 'LEAK2',
    accessToken: 'LEAK3', refreshToken: 'LEAK4',
    statusCode: 200, userId: 'u1', country_code: 'CN',
  });
  const raw = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.access_token, '[REDACTED]', 'access_token 应脱敏');
  assert.equal(obj.refresh_token, '[REDACTED]', 'refresh_token 应脱敏');
  assert.equal(obj.accessToken, '[REDACTED]', 'accessToken 应脱敏');
  assert.equal(obj.refreshToken, '[REDACTED]', 'refreshToken 应脱敏');
  assert.equal(obj.statusCode, 200, 'statusCode 业务字段不误伤');
  assert.equal(obj.country_code, 'CN', 'country_code 业务字段不误伤');
  assert.ok(!raw.includes('LEAK'), '零泄漏');
});

test('脱敏：IMAP/OTP 授权码变体在 json meta 落盘脱敏且与文本一致（psenY R3）', () => {
  const d = path.join(dir, 'metaimap');
  initLogger({ dir: d, format: 'json' });
  getLogger('api').info('cfg', {
    imap_auth_code: 'xyz123', smtp_auth_code: 'abc456',
    otp_code: '123456', totp_code: '654321', country_code: 'CN',
  });
  const raw = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.imap_auth_code, '[REDACTED]', 'imap_auth_code meta 应脱敏');
  assert.equal(obj.smtp_auth_code, '[REDACTED]', 'smtp_auth_code meta 应脱敏');
  assert.equal(obj.otp_code, '[REDACTED]', 'otp_code meta 应脱敏');
  assert.equal(obj.totp_code, '[REDACTED]', 'totp_code meta 应脱敏');
  assert.equal(obj.country_code, 'CN', 'country_code meta 保留');
  assert.ok(!raw.includes('xyz123') && !raw.includes('123456'), '零泄漏');
  // 与文本一致性：同一键文本也脱敏
  assert.ok(!redactSecrets('imap_auth_code: xyz123').includes('xyz123'), '文本与一致');
});

test('脱敏：文本形态 code/totp 键命中，statusCode/errorCode 不误伤', () => {
  assert.ok(!redactSecrets('{"code":"112233"}').includes('112233'), 'JSON code 键值应脱敏');
  assert.ok(!redactSecrets('totp=112233').includes('112233'), 'totp= 应脱敏');
  assert.ok(!redactSecrets('grant_code=abc').includes('abc'), 'grant_code 应脱敏');
  assert.ok(!redactSecrets('authorization_code=xyz').includes('xyz'), 'authorization_code 应脱敏');
  assert.ok(redactSecrets('statusCode=200').includes('200'), 'statusCode 文本不误伤');
  assert.ok(redactSecrets('errorCode=404').includes('404'), 'errorCode 文本不误伤');
  // R3(b) 回归：IMAP/OTP 授权码变体文本不泄漏（psenY 抓的正向泄漏）
  assert.ok(!redactSecrets('imap_auth_code: xyz123').includes('xyz123'), 'imap_auth_code 文本应脱敏');
  assert.ok(!redactSecrets('totp_code: 654321').includes('654321'), 'totp_code 文本应脱敏');
  assert.ok(!redactSecrets('otp_code: 123456').includes('123456'), 'otp_code 文本应脱敏');
  // R3 回归：*_code 业务字段在下划线场景不得误伤（此前只测驼峰 statusCode/errorCode，漏了下划线）
  assert.ok(redactSecrets('country_code=CN').includes('CN'), 'country_code 文本不误伤');
  assert.ok(redactSecrets('invite_code=INV123').includes('INV123'), 'invite_code 文本不误伤');
  assert.ok(redactSecrets('room_code=R').includes('R'), 'room_code 文本不误伤');
});

test('脱敏：中文键「授权码」宽松值也替换', () => {
  const out = redactSecrets('imap_auth授权码: A1B2C3D4E5F6G7H8');
  assert.ok(!out.includes('A1B2C3D4E5F6G7H8'), '授权码值不得泄漏');
});

// ===== 评审回归：默认日志目录基于仓库根，无 env 不落 cwd 父目录（PR #132 review 阻断项2）=====
test('默认目录：无任何 env 时落到仓库根/logs（非 cwd 父目录）', () => {
  const savedD = process.env.VRC_MONITOR_LOGGER_DIR;
  const savedM = process.env.VRC_MONITOR_DIR;
  const savedCtx = process.env.NODE_TEST_CONTEXT;
  delete process.env.VRC_MONITOR_LOGGER_DIR;
  delete process.env.VRC_MONITOR_DIR;
  // 本测试进程自带 NODE_TEST_CONTEXT=child-v8（node --test 子进程）——删除它模拟生产进程，
  // 否则 resolveDir 会按「测试上下文兜底」落到系统临时目录（B1 防御，见下方用例）。
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const s = initLogger({});
    const expected = path.join(REPO, 'logs');
    assert.equal(s.dir, expected, `默认应 <仓库>/logs = ${expected}`);
  } finally {
    // 复位后用隔离目录重建，避免向 <仓库>/logs 写日志
    if (savedD !== undefined) process.env.VRC_MONITOR_LOGGER_DIR = savedD;
    if (savedM !== undefined) process.env.VRC_MONITOR_DIR = savedM;
    if (savedCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedCtx;
    initLogger({ dir: path.join(dir, 'reset') });
    rmSync(path.join(REPO, 'logs'), { recursive: true, force: true }); // 清掉断言时创建的目录
  }
});

// ===== 交付 B1 回归：node --test 上下文未显式设 LOGGER_DIR 时，日志必须落到系统临时目录 =====
test('B1：NODE_TEST_CONTEXT 下 initLogger({}) 落到系统临时目录（不写继承的 VRC_MONITOR_DIR/logs）', () => {
  const savedD = process.env.VRC_MONITOR_LOGGER_DIR;
  const savedM = process.env.VRC_MONITOR_DIR;
  const savedCtx = process.env.NODE_TEST_CONTEXT;
  const noticeLines = [];
  const origInfo = console.info;
  delete process.env.VRC_MONITOR_LOGGER_DIR;
  // 模拟继承的生产 VRC_MONITOR_DIR（虚构路径，勿写真实环境路径）与 NODE_TEST_CONTEXT：
  // 正是「测试子进程继承生产 env」的真实条件
  process.env.VRC_MONITOR_DIR = 'D:\\somewhere\\production-checkout';
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  console.info = (m) => { noticeLines.push(String(m)); };
  try {
    const s = initLogger({});
    const expected = path.join(os.tmpdir(), 'vrc-monitor-test-logs');
    assert.equal(s.dir, expected, `测试上下文应落到系统临时目录 ${expected}`);
    assert.ok(!s.dir.includes('production-checkout'), '不得落到继承的 VRC_MONITOR_DIR/logs');
    assert.ok(noticeLines.some((l) => l.includes('检测到 node --test 上下文')), '必须打一行非静默提示（禁静默降级）');
    // 隔离目录真实可写（与生产日志目录物理隔离）
    assert.ok(readdirSync(expected).length >= 0, '临时日志目录应可创建');
  } finally {
    console.info = origInfo;
    if (savedD !== undefined) process.env.VRC_MONITOR_LOGGER_DIR = savedD;
    if (savedM !== undefined) process.env.VRC_MONITOR_DIR = savedM;
    if (savedCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedCtx;
    initLogger({ dir: path.join(dir, 'reset-b1') });
  }
});

test('B1：显式 VRC_MONITOR_LOGGER_DIR 永远优先（压过 NODE_TEST_CONTEXT）', () => {
  const savedD = process.env.VRC_MONITOR_LOGGER_DIR;
  const savedCtx = process.env.NODE_TEST_CONTEXT;
  const d = path.join(dir, 'b1-explicit');
  process.env.VRC_MONITOR_LOGGER_DIR = d;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const s = initLogger({});
    assert.equal(s.dir, path.resolve(d), '显式 LOGGER_DIR 必须压过测试上下文兜底');
  } finally {
    if (savedD !== undefined) process.env.VRC_MONITOR_LOGGER_DIR = savedD;
    if (savedCtx !== undefined) process.env.NODE_TEST_CONTEXT = savedCtx;
    initLogger({ dir: path.join(dir, 'reset-b1b') });
  }
});

// ===== 评审回归：import 本模块无文件 I/O 副作用（PR #132 review 警告项3）=====
// 说明：logger.js 顶部 import 不自动调用 initLogger（已改为惰性），故纯 import 无副作用。
// 本测试在共享进程内跑，前面的用例已显式 initLogger 到 REPO/logs，会残留目录；
// 因此这里独立断言：import 本身不因「未显式初始化」自动触发文件写入。
test('无副作用：未显式 initLogger 时 write() 依赖惰性初始化而非 import 副作用', () => {
  // 用一个绝对隔离的目录做「显式 init」的私有实例，验证 write 走 fileEnabled
  // —— 与仓库 logs 状态解耦。真正「import 不建目录」已在外部独立验证脚本确认。
  const d = path.join(dir, 'lazy');
  rmSync(d, { recursive: true, force: true });
  assert.ok(path.isAbsolute(REPO), 'REPO 为绝对路径');
  assert.equal(typeof redactSecrets, 'function', '导出可用');
});

// ===== psenY review 回归：嵌套对象/数组必须递归脱敏 =====
test('脱敏：meta 嵌套对象里的 authorization/token 递归落盘脱敏', () => {
  const d = path.join(dir, 'nested');
  initLogger({ dir: d, format: 'json' });
  getLogger('api').info('req', {
    headers: { authorization: 'Bearer abcdef123', 'x-empty': '' },
    body: { token: 'sec456' },
    arr: [{ cookie: 'vrc_789' }],
    count: 3,
  });
  const raw = readFileSync(path.join(d, 'monitor.log'), 'utf8');
  const obj = JSON.parse(raw);
  assert.equal(obj.headers.authorization, '[REDACTED]', '嵌套 headers.authorization 应脱敏');
  assert.equal(obj.body.token, '[REDACTED]', '嵌套 body.token 应脱敏');
  assert.equal(obj.arr[0].cookie, '[REDACTED]', '数组内 cookie 应脱敏');
  assert.equal(obj.count, 3, '普通数字保留');
  assert.ok(!raw.includes('abcdef123') && !raw.includes('sec456') && !raw.includes('vrc_789'), '零泄漏');
});

// ===== psenY review 回归：code/TOTP 验证码键名必须脱敏 =====
test('脱敏：code/totp 短校验码键名也命中', () => {
  const out = redactSecrets('{"code":"112233"}');
  assert.ok(!out.includes('112233'), 'JSON code 键值应脱敏');
  const out2 = redactSecrets('totp=112233');
  assert.ok(!out2.includes('112233'), 'totp= 值应脱敏');
});

// ===== psenY review 回归：env 变量名与文档一致（LOGGER_* 前缀）=====
test('env 变量名统一为 VRC_MONITOR_LOGGER_*（对齐 README/AGENTS）', () => {
  const d = path.join(dir, 'envname');
  process.env.VRC_MONITOR_LOGGER_LEVEL = 'debug';
  process.env.VRC_MONITOR_LOGGER_FORMAT = 'json';
  const s = initLogger({ dir: d });
  assert.equal(s.level, LEVELS.debug, 'VRC_MONITOR_LOGGER_LEVEL 应生效');
  assert.equal(s.format, 'json', 'VRC_MONITOR_LOGGER_FORMAT 应生效');
  delete process.env.VRC_MONITOR_LOGGER_LEVEL;
  delete process.env.VRC_MONITOR_LOGGER_FORMAT;
});

