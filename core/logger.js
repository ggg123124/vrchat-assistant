import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// 仓库根 = 本模块(core/logger.js)上溯一层。默认日志目录基于它稳定定位，
// 不随 process.cwd() 漂移（Hermes 插件 Popen / systemd 只设 WorkingDirectory 不注入 env 的场景）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// 敏感词单一来源：redactSecrets 文本正则与 meta 键名判定共用，避免两处漂移。
// 开放词根：允许被 `_`/`-`/驼峰 前缀包裹（access_token / refreshToken / grant_code），
// 内含具体 OAuth/凭证变体，避免泛化 code/secrets 误伤 country_code/errorCode。
// IMAP/OTP 授权码变体（credentials.json 真实字段）必须完整入表，
// 否则文本 openKey 只匹配「词根紧跟分隔符」会在 imap_auth_code 处漏脱（仅 meta 开边界命中）。
const SENSITIVE_WORDS = [
  'authToken', 'authorization', 'authorization_code', 'set-cookie', 'apiKey',
  'api_key', 'authcode', 'password', 'passwd', 'cookie', 'secret',
  'client_secret', 'api_secret', 'smtp', 'imap', 'pwd', 'token',
  'access_token', 'refresh_token', 'id_token', 'session_token', 'login_token',
  'grant_code', 'verification_code', 'auth', 'credential',
  'imap_auth_code', 'smtp_auth_code', 'auth_code', 'otp_code', 'totp_code',
];
// TOTP 校验码等**仅精确整键**才视为敏感（状态类字段 code/level 不误伤）。
const SENSITIVE_EXACT = ['code', 'totp', 'otp', 'pin'];

// 键名判定：与文本正则同语义——词根前后为 非字母数字 边界（允许 `_`/`-`/`^`/`$`），
// 并接受驼峰切换点（小写→大写，如 accessToken 的 `access|Token`）。
// 因此 access_token / refresh_token / accessToken / refreshToken / grant_code 命中；
// 而 tokenizer / tokens / country_code / statusCode / errorCode 不误伤。
const SENSITIVE_KEY_RE = new RegExp(
  `(^|[^A-Za-z0-9]|(?<=[a-z])(?=[A-Z]))(?:${SENSITIVE_WORDS.join('|')})(?![A-Za-z0-9])`,
  'i'
);
const isSensitiveKey = (key) =>
  SENSITIVE_KEY_RE.test(String(key)) || SENSITIVE_EXACT.includes(String(key));

// 递归脱敏值：对 meta 值做深遍历——敏感 key 命中 → 整值 [REDACTED]；
// 字符串 → redactSecrets；数组 → 逐元素；普通对象 → 逐键递归。防嵌套对象里藏凭据落盘。
function redactValue(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactValue(v);
    }
    return out;
  }
  return value;
}

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const state = {
  level: LEVELS.info,
  dir: '',
  format: 'text',
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
  console: true,
  color: 'auto',
  suppress: [],
  filePath: '',
  fileEnabled: false,
  closed: false,
  pid: process.pid,
};

function resolveDir() {
  // 日志模块专属变量名（VRC_MONITOR_LOGGER_DIR），不与 AGENTS.md 里 service-windows 用的 VRC_MONITOR_LOG_DIR 撞名
  if (process.env.VRC_MONITOR_LOGGER_DIR) {
    return path.resolve(process.env.VRC_MONITOR_LOGGER_DIR);
  }
  // node --test 上下文（node --test 子进程 NODE_TEST_CONTEXT=child-v8，已实测）：
  // 任何继承 VRC_MONITOR_DIR 的测试进程都会把日志写进生产目录（实测 96 行 wrld_kbtest-*
  // 测试夹具污染主仓库生产日志），单点防御落到系统临时目录与生产日志物理隔离。
  // 显式 VRC_MONITOR_LOGGER_DIR 永远优先（上方分支），此处只在未显式指定时兜底。
  if (process.env.NODE_TEST_CONTEXT) {
    const dir = path.join(os.tmpdir(), 'vrc-monitor-test-logs');
    console.info(`[logger] 检测到 node --test 上下文，日志落盘改用临时目录: ${dir}（如需显式指定请设 VRC_MONITOR_LOGGER_DIR）`);
    return dir;
  }
  if (process.env.VRC_MONITOR_DIR) {
    return path.join(process.env.VRC_MONITOR_DIR, 'logs');
  }
  // 兜底：基于仓库根，而非 cwd。保证无 env 时默认日志落在 <仓库>/logs（与文档一致）
  return path.join(REPO_ROOT, 'logs');
}

function parseLevel(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return LEVELS.info;
  const key = value.trim().toLowerCase();
  return LEVELS[key] ?? LEVELS.info;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const s = String(value).trim();
  if (s === '' || s === '0' || s.toLowerCase() === 'false') return false;
  return true;
}

function parseIntDefault(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const n = parseInt(String(value), 10);
  return Number.isNaN(n) ? defaultValue : n;
}

function parseSuppress(value) {
  if (!value || String(value).trim() === '') return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildConfig(options) {
  const envOrOpt = (envKey, optKey) => {
    if (options && optKey in options) return options[optKey];
    return process.env[envKey];
  };

  const dir = options && 'dir' in options ? options.dir : resolveDir();
  const formatRaw = envOrOpt('VRC_MONITOR_LOGGER_FORMAT', 'format');
  const colorRaw = envOrOpt('VRC_MONITOR_LOGGER_COLOR', 'color');

  return {
    level: parseLevel(options?.level ?? process.env.VRC_MONITOR_LOGGER_LEVEL),
    dir,
    format: formatRaw === 'json' ? 'json' : 'text',
    maxSize: parseIntDefault(
      envOrOpt('VRC_MONITOR_LOGGER_MAX_SIZE', 'maxSize'),
      10 * 1024 * 1024
    ),
    maxFiles: parseIntDefault(
      envOrOpt('VRC_MONITOR_LOGGER_MAX_FILES', 'maxFiles'),
      5
    ),
    console: parseBool(
      envOrOpt('VRC_MONITOR_LOGGER_CONSOLE', 'console'),
      true
    ),
    color:
      colorRaw === 'auto' || colorRaw === undefined || colorRaw === null
        ? 'auto'
        : parseBool(colorRaw, false),
    suppress: parseSuppress(
      envOrOpt('VRC_MONITOR_LOGGER_SUPPRESS', 'suppress')
    ),
  };
}

export function initLogger(options = {}) {
  const cfg = buildConfig(options);

  lazyInit = true; // 显式初始化标记：后续 write() 不再触发惰性兜底
  state.level = cfg.level;
  state.dir = cfg.dir;
  state.format = cfg.format;
  state.maxSize = cfg.maxSize;
  state.maxFiles = cfg.maxFiles;
  state.console = cfg.console;
  state.color = cfg.color;
  state.suppress = cfg.suppress;
  state.filePath = path.join(state.dir, 'monitor.log');
  state.fileEnabled = true;
  state.closed = false;
  state.pid = process.pid;

  try {
    fs.mkdirSync(state.dir, { recursive: true });
    const testPath = path.join(state.dir, '.init-test');
    fs.writeFileSync(testPath, '');
    fs.unlinkSync(testPath);
  } catch (err) {
    state.fileEnabled = false;
    state.filePath = '';
    if (state.console) {
      console.warn(
        `[logger] 日志目录不可写，已降级为仅 console: ${err.message}`
      );
    }
  }

  return state;
}

function isOutputEnabled(level) {
  return level >= state.level;
}

function shouldSuppress(msg) {
  if (!state.suppress.length) return false;
  return state.suppress.some((sub) => msg.includes(sub));
}

export function redactSecrets(text) {
  if (typeof text !== 'string') return text;

  let out = text;

  // 敏感键值对：键可被引号包裹（JSON），分隔符 = 或 :，值可为
  //   - 双引号串   "secret"
  //   - 单引号串   'secret'
  //   - Bearer token (空格分隔: Bearer eyJ...)
  //   - 裸值       secret123
  // 敏感词列表 = 单一来源 SENSITIVE_WORDS + code 类校验码。
  // 边界与 isSensitiveKey 同语义：前缀接受 非字母数字 或 驼峰切换点（`_`/`-`/`access|Token`），
  // 后缀拒绝紧跟字母数字（防 tokenizer/tokens）。
  // code/totp/otp/pin 校验码**不做驼峰开放**（否则 statusCode/errorCode 误伤），仅接受严格键形前缀。
  // 开放词根：支持驼峰/下划线/连字符前缀（access_token / refreshToken / grant_code 命中）
  const openWords = SENSITIVE_WORDS;
  const openKey =
    '["\']?(?:^|[^A-Za-z0-9]|(?<=[a-z])(?=[A-Z]))(?:' + openWords.join('|') + ')(?![A-Za-z0-9])["\']?';
  // 校验码：仅「严格整键」才脱敏（前缀不接受 下划线/连字符/驼峰，防 *_code 业务字段误伤）。
  // 因此 country_code / invite_code / room_code / postal_code / group_code 不命中；
  // 而裸 code / totp / otp / pin（前面是 =、:、空格、^、引号）命中；
  // grant_code / authorization_code 等凭证变体由上方 openWords 完整词匹配。
  const exactKey =
    '["\']?(?:^|[^A-Za-z0-9_-])(?:code|totp|otp|pin)(?![A-Za-z0-9])["\']?';
  // 值捕获：双引号串/单引号串/Bearer token/裸值（引号保留 + 值整段吞没）
  const val = `(?:\\"([^\\"]*)\\"|\\'([^\\']*)\\'|(Bearer\\s+[^\\s,;]+)|([^\\s,;]+))`;
  // 键名+分隔符整体作 prefix 捕获，替换后保留 `key=`/`key:` 形式
  out = out.replace(
    new RegExp(`((?:${openKey}|${exactKey})\\s*[:=]\\s*)${val}`, 'gi'),
    (m, prefix, dq, sq, bearer, bare) => redactReplacer(prefix, dq, sq, bearer, bare)
  );

  // 中文键「授权码」：\b 对 CJK 无效，单独用宽松值兜底
  out = out.replace(/((?:授权码)\s*[:=:：]\s*)(\S+)/gi, '$1[REDACTED]');

  // 兜底：邮箱
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[REDACTED]');

  return out;
}

// 敏感值替换回调：保留原引号风格（双引号/单引号/Bearer 前缀），其余置 [REDACTED]
function redactReplacer(prefix, dq, sq, bearer, bare) {
  if (dq !== undefined) return `${prefix}"[REDACTED]"`;
  if (sq !== undefined) return `${prefix}'[REDACTED]'`;
  if (bearer !== undefined) return `${prefix}Bearer [REDACTED]`;
  return `${prefix}[REDACTED]`;
}

function formatText(ts, levelName, name, msg) {
  const upper = levelName.toUpperCase().padEnd(5);
  return `${ts} ${upper} [${name}] ${msg}`;
}

function formatJson(ts, levelName, name, msg, meta) {
  const obj = {
    ts,
    level: levelName.toLowerCase(),
    name,
    msg,
    pid: state.pid,
  };
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (!(key in obj)) {
        obj[key] = value;
      }
    }
  }
  return JSON.stringify(obj);
}

function applyColor(line, levelName) {
  const reset = '\x1b[0m';
  switch (levelName.toLowerCase()) {
    case 'debug':
      return `\x1b[90m${line}${reset}`;
    case 'info':
      return `\x1b[32m${line}${reset}`;
    case 'warn':
      return `\x1b[33m${line}${reset}`;
    case 'error':
      return `\x1b[31m${line}${reset}`;
    default:
      return line;
  }
}

function writeToConsole(levelName, line) {
  if (!state.console) return;

  let output = line;
  const useColor =
    state.color === true ||
    (state.color === 'auto' && process.stdout.isTTY && state.format === 'text');
  if (useColor) {
    output = applyColor(line, levelName);
  }

  switch (levelName) {
    case 'debug':
      console.debug(output);
      break;
    case 'info':
      console.info(output);
      break;
    case 'warn':
      console.warn(output);
      break;
    case 'error':
      console.error(output);
      break;
    default:
      console.log(output);
  }
}

function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(state.dir);
    const gzFiles = files
      .filter((f) => f.endsWith('.log.gz'))
      .map((f) => {
        const full = path.join(state.dir, f);
        return { name: f, path: full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);

    while (gzFiles.length > state.maxFiles) {
      const oldest = gzFiles.shift();
      try {
        fs.unlinkSync(oldest.path);
      } catch {
        // ignore cleanup errors
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

function doRotate() {
  if (!state.fileEnabled || !fs.existsSync(state.filePath)) return;

  const now = new Date();
  // UTC 时间戳 → YYYYMMDD-HHMMSS（去 ISO 连字符/冒号，T 转 -），与 plan 命名约定对齐
  const ts = now.toISOString().replace(/-/g, '').replace(/:/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
  const rotatedName = `monitor-${ts}-${state.pid}.log`;
  const rotatedPath = path.join(state.dir, rotatedName);

  try {
    fs.renameSync(state.filePath, rotatedPath);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      const warnLine = `${new Date().toISOString()} WARN  [logger] 轮转失败，跳过本次: ${err.message}`;
      if (state.console) console.warn(warnLine);
      return;
    }
    throw err;
  }

  try {
    const data = fs.readFileSync(rotatedPath);
    const gz = zlib.gzipSync(data);
    fs.writeFileSync(`${rotatedPath}.gz`, gz);
    fs.unlinkSync(rotatedPath);
    cleanupOldLogs();
  } catch {
    // gzip failed: keep uncompressed rotated file
  }
}

function checkRotation(line) {
  if (!state.fileEnabled || !fs.existsSync(state.filePath)) return;
  const stats = fs.statSync(state.filePath);
  const lineBytes = Buffer.byteLength(line, 'utf8');
  if (stats.size + lineBytes > state.maxSize) {
    doRotate();
  }
}

function write(levelName, name, msg, meta) {
  if (state.closed) return;

  ensureInitialized();

  const rawMsg = typeof msg === 'string' ? msg : String(msg);
  if (shouldSuppress(rawMsg)) return;

  const levelValue = LEVELS[levelName] ?? LEVELS.info;
  if (!isOutputEnabled(levelValue)) return;

  const ts = new Date().toISOString();
  const redactedMsg = redactSecrets(rawMsg);

  let line;
  if (state.format === 'json') {
    // 递归脱敏 meta：敏感 key 命中的整值、嵌套对象/数组里的字符串都过脱敏。
    // 修复 psenY review 指出的「嵌套对象 authorization/token 原样落盘」。
    const safeMeta = redactValue(meta);
    line = formatJson(ts, levelName, name, redactedMsg, safeMeta);
  } else {
    line = formatText(ts, levelName, name, redactedMsg);
  }

  writeToConsole(levelName, line);

  if (state.fileEnabled && state.filePath) {
    try {
      // 多行消息按行拆分落盘：每行都带完整前缀。否则「前缀+空正文」行会被解析成
      // 空条目（日志页出现空行）、无前缀的续行（如 `\n[启动]...` 的正文、error.stack）
      // 会被解析器整行丢弃（日志页数据丢失）。空段跳过——装饰性 '\n' 不再产生空行。
      const fileLines = state.format === 'json'
        ? [line]
        : redactedMsg.split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((seg) => formatText(ts, levelName, name, seg));
      for (const fl of fileLines) {
        checkRotation(fl);
        fs.appendFileSync(state.filePath, `${fl}\n`, 'utf8');
      }
    } catch (err) {
      if (state.console) {
        console.error(`[logger] 写入日志文件失败: ${err.message}`);
      }
    }
  }
}

export const logger = {
  debug(msg, meta) { write('debug', 'app', msg, meta); },
  info(msg, meta) { write('info', 'app', msg, meta); },
  warn(msg, meta) { write('warn', 'app', msg, meta); },
  error(msg, meta) { write('error', 'app', msg, meta); },
};

export function getLogger(name) {
  const n = String(name ?? 'app');
  return {
    debug(msg, meta) { write('debug', n, msg, meta); },
    info(msg, meta) { write('info', n, msg, meta); },
    warn(msg, meta) { write('warn', n, msg, meta); },
    error(msg, meta) { write('error', n, msg, meta); },
    name: n,
  };
}

export function setLevel(level) {
  state.level = parseLevel(level);
}

// 把级别数字转回人类可读名（供 ctx.paths.LOG_LEVEL 展示 / MCP 工具用）
export function getLevelName(level) {
  const n = parseLevel(level);
  for (const [name, val] of Object.entries(LEVELS)) {
    if (val === n) return name;
  }
  return 'info';
}

export function rotate() {
  doRotate();
}

export function closeLogger() {
  state.closed = true;
  state.fileEnabled = false;
  state.console = false;
}

// 惰性初始化：import 本模块不触发任何文件 I/O（避免副作用扩散到任何 import 链）。
// 首次真正 write() 且尚未显式 initLogger 时，以默认配置初始化一次。
let lazyInit = false;
function ensureInitialized() {
  if (lazyInit) return;
  lazyInit = true;
  // 仅当尚未初始化（filePath 为空）时用默认配置兜底；已显式 init 过则跳过
  if (!state.filePath) {
    try {
      initLogger();
    } catch {
      // 初始化失败也不阻断日志路径（console 仍可用）
    }
  }
}
