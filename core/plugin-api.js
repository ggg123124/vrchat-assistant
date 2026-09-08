import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Plugin API v1 — 为插件提供与核心交互的 6 个 API 表面。
 *
 * buildPluginApi(pluginName, { registry, ctx, services, serviceOwners, log })
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCoreTables() {
  const tables = new Set();
  const extract = (file) => {
    try {
      const ddl = readFileSync(path.join(__dirname, file), 'utf-8');
      const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi;
      let m;
      while ((m = re.exec(ddl)) !== null) {
        tables.add(m[1].toLowerCase());
      }
    } catch { /* ignore */ }
  };
  extract('init-db.sql');
  extract('init-x-worlds.sql');
  return tables;
}

const CORE_TABLES = loadCoreTables();

/**
 * 构建插件 API 对象。
 * @param {string} pluginName 插件名（清单 name）
 * @param {object} deps
 * @param {object} deps.registry 核心注册表
 * @param {object} deps.ctx 服务上下文
 * @param {Map} deps.services 全局服务注册表（跨插件共享）
 * @param {Map} deps.serviceOwners 服务提供者记录（name -> pluginName）
 * @param {function} deps.log 核心日志函数
 * @returns {object} api 对象
 */
export function buildPluginApi(pluginName, { registry, ctx, services, serviceOwners, log }) {
  const prefix = `plg_${pluginName}_`;
  const db = buildDbNamespace({ pluginName, prefix, ctx });

  function apiLog(message) {
    log(`[plugin:${pluginName}] ${message}`);
  }

  return {
    registerTool(def) {
      registry.registerPluginTool(def, pluginName);
    },

    db,

    vrchat: buildVrchatApi({ ctx, log: apiLog }),

    log: apiLog,

    // HTTP 路由注册：插件可挂载自定义路由（/mcp、/health 之外的路径）。
    // 核心 http-server 统一分发，路由随插件卸载自动清理。
    http: {
      registerRoute(route) {
        if (!route || typeof route.path !== 'string' || typeof route.handler !== 'function') {
          throw new Error('http.registerRoute 需要 path 与 handler');
        }
        const method = String(route.method || 'GET').toUpperCase();
        const key = `${method} ${route.path}`;
        if (ctx.httpRoutes.has(key)) throw new Error(`HTTP 路由冲突: ${key}`);
        ctx.httpRoutes.set(key, { method, path: route.path, handler: route.handler, pluginName });
      },
      removeRoutes() {
        for (const [key, route] of ctx.httpRoutes.entries()) {
          if (route.pluginName === pluginName) ctx.httpRoutes.delete(key);
        }
      },
    },

    tools: {
      call(name, args = {}) {
        if (!registry.hasTool(name)) {
          throw new Error(`工具 ${name} 不存在：对应插件未安装或未加载`);
        }
        return registry.dispatch(name, args);
      },
      has(name) {
        return registry.hasTool(name);
      },
    },

    provide(name, fn) {
      if (typeof fn !== 'function') {
        throw new Error(`provide("${name}"): 第二个参数必须是函数`);
      }
      if (services.has(name)) {
        const owner = serviceOwners.get(name);
        if (owner !== pluginName) {
          throw new Error(`服务名冲突："${name}" 已由 ${owner} 提供`);
        }
      }
      services.set(name, fn);
      serviceOwners.set(name, pluginName);
    },

    consume(name, ...args) {
      if (!services.has(name)) {
        throw new Error(`服务 ${name} 不存在：对应插件未安装或未加载`);
      }
      const fn = services.get(name);
      return fn(...args);
    },

    hasService(name) {
      return services.has(name);
    },
  };
}

// ── 插件 DB 沙箱：表名白名单（docs/PLUGIN-API.md §4.2 契约）──
// 表名位置的关键字：其后（跳过修饰词）的标识符是表名
const TABLE_INTRO_KEYWORDS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'REFERENCES']);
// 表名位置可跳过的修饰词（DDL 的 IF NOT EXISTS、UPDATE OR REPLACE 等）
const TABLE_MODIFIER_KEYWORDS = new Set([
  'IF', 'NOT', 'EXISTS', 'OR', 'ABORT', 'FAIL', 'IGNORE', 'REPLACE', 'ROLLBACK',
]);
// 表名候选位置出现的非表名 SQL 关键字（子查询/表达式开头），出现即放弃本次候选
const NON_TABLE_KEYWORDS = new Set([
  'SELECT', 'WITH', 'VALUES', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'SET', 'AS',
  'UNION', 'INTERSECT', 'EXCEPT', 'HAVING', 'RETURNING', 'WINDOW', 'FILTER', 'OVER',
  'CONFLICT', 'DO', 'AND', 'BY', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'USING', 'ON', 'IN', 'IS', 'LIKE', 'GLOB', 'MATCH', 'REGEXP', 'BETWEEN', 'COLLATE', 'ASC', 'DESC',
  'OF',
  'INDEXED', 'NULL', 'DISTINCT', 'ALL', 'CROSS', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'NATURAL',
  'DEFAULT', 'PRIMARY', 'FOREIGN', 'KEY', 'CHECK', 'UNIQUE', 'CONSTRAINT',
]);
// PRAGMA 带表名参数的 pragma 名（PRAGMA table_info(plg_x_t) 等）
const PRAGMA_TABLE_NAMES = new Set([
  'TABLE_INFO', 'TABLE_XINFO', 'INDEX_LIST', 'INDEX_INFO', 'INDEX_XINFO', 'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK',
]);
// FROM 位置允许的表值函数（#167 ⚠️1：json_each 等返回行集而非读表，不构成越权）。
// 集合外函数在表名位置仍按外来标识符拒绝（保守白名单制）。
const TABLE_VALUED_FUNCTIONS = new Set([
  'JSON_EACH', 'JSON_TREE', 'PRAGMA_TABLE_INFO', 'PRAGMA_TABLE_XINFO',
  'GENERATE_SERIES', 'VALUE_LIST', 'SQLITE_EXPIRED_STATEMENTS',
]);
// 语句级拒绝：作用域为整个数据库/连接、不出现表名位置、可整库导出或外部挂载的语句
// （#167 ⚠️2：VACUUM INTO 可整库导出；ATTACH/DETACH 挂载外部库后可跨库引用核心表）
const FORBIDDEN_STATEMENTS = new Set(['VACUUM', 'ATTACH', 'DETACH']);

/**
 * 白名单扫描：SQL 中表名位置的标识符必须全部以本插件 prefix 开头。
 * 返回第一个违规表名，全合法返回 null。跳过字符串字面量、注释、嵌套子查询关键字、
 * WITH CTE 名（CTE 内部 FROM 仍会被检查，不会形成绕过）。
 */
export function findForeignTableName(sql, prefix) {
  const n = sql.length;
  let i = 0;
  let expectingTable = false;   // 上一个关键字引入了表名，等待候选
  let stmtFirst = true;         // 处于语句首
  let stmtKind = 'other';       // 'index-trigger' 时首个 ON 引入表名（CREATE INDEX/TRIGGER）
  let pendingCreate = false;    // 语句首词是 CREATE，等待 INDEX/TRIGGER 判定
  let pragmaPending = false;    // 语句首词是 PRAGMA，等待 pragma 名
  let onConsumed = false;       // 本语句首个 ON 是否已用于表名位置
  let inWith = false;           // WITH 子句中（收集 CTE 名）
  let renameTo = false;         // ALTER ... RENAME TO 的目标名位置（review #169 建议#2）
  let parenDepth = 0;
  const cteNames = new Set();

  const resetStatement = () => {
    expectingTable = false;
    stmtFirst = true;
    stmtKind = 'other';
    pendingCreate = false;
    pragmaPending = false;
    onConsumed = false;
    inWith = false;
    renameTo = false;
  };

  while (i < n) {
    const ch = sql[i];

    // 字符串字面量：内容不是表名，整体跳过（'' 转义）
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // 行注释 / 块注释
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }

    // 引号标识符（"..."、`...`、[...]）
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      let ident = '';
      while (j < n && sql[j] !== close) { ident += sql[j]; j++; }
      i = j < n ? j + 1 : j;
      if (expectingTable) {
        if (!ident.toLowerCase().startsWith(prefix)) return ident;
        expectingTable = false;
      }
      continue;
    }

    if (ch === '(') { parenDepth++; i++; continue; }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      if (expectingTable) expectingTable = false;
      i++;
      continue;
    }
    if (ch === ';') { resetStatement(); i++; continue; }

    // 词（标识符/关键字）
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let word = '';
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) { word += sql[j]; j++; }
      i = j;
      const up = word.toUpperCase();

      // WITH 子句（深度 0）：收集 CTE 名（词后紧跟 ( 或 AS），主 SELECT 出现即结束
      if (inWith && parenDepth === 0) {
        if (up === 'SELECT') {
          inWith = false;
        } else {
          let k = i;
          while (k < n && /\s/.test(sql[k])) k++;
          if (sql[k] === '(') cteNames.add(word.toLowerCase());
          else if (sql.startsWith('AS', k) && !/[A-Za-z0-9_]/.test(sql[k + 2] || '')) {
            cteNames.add(word.toLowerCase());
          }
        }
      }

      // 语句首词判定：只设标志并跳过后续处理，避免首词自身把 pendingCreate/pragmaPending
      // 立即消费掉（否则 CREATE INDEX 的 INDEX、PRAGMA table_info 的 TABLE_INFO 永远等不到标志）。
      // UPDATE/DELETE/DROP 等首词不 continue，继续参与表名引入判定。
      if (stmtFirst) {
        stmtFirst = false;
        if (FORBIDDEN_STATEMENTS.has(up)) {
          return `__stmt:${up}`;   // #167 ⚠️2：VACUUM/ATTACH/DETACH 作用域为整库，整条拒绝
        }
        if (up === 'CREATE') { pendingCreate = true; continue; }
        if (up === 'WITH') { inWith = true; continue; }
        if (up === 'PRAGMA') { pragmaPending = true; continue; }
      }
      if (pendingCreate) {
        if (up !== 'UNIQUE' && up !== 'TEMP' && up !== 'TEMPORARY') {
          if (up === 'INDEX' || up === 'TRIGGER') stmtKind = 'index-trigger';
          pendingCreate = false;
        }
      }
      if (pragmaPending) {
        pragmaPending = false;
        if (PRAGMA_TABLE_NAMES.has(up)) expectingTable = true;
        continue;
      }

      // 期待表名时的候选处理
      if (expectingTable) {
        if (TABLE_MODIFIER_KEYWORDS.has(up)) { /* 保持期待 */ }
        else if (NON_TABLE_KEYWORDS.has(up)) { expectingTable = false; }
        else if (TABLE_VALUED_FUNCTIONS.has(up)) {
          // 表值函数（json_each 等返回行集，不读表）→ 放行，跳过其括号参数
          expectingTable = false;
          continue;
        }
        else if (cteNames.has(word.toLowerCase())) { expectingTable = false; }
        else {
          if (!word.toLowerCase().startsWith(prefix)) return word;
          expectingTable = false;
        }
      }

      // 关键字引入表名；CREATE INDEX/TRIGGER 语句中首个 ON 引入表名
      if (TABLE_INTRO_KEYWORDS.has(up)) expectingTable = true;
      if (up === 'ON' && stmtKind === 'index-trigger' && !onConsumed) {
        onConsumed = true;
        expectingTable = true;
      }
      // ALTER ... RENAME TO <目标>（review #169 建议#2）：目标名与 FROM 同级校验
      // RENAME COLUMN 的目标是列名，遇 COLUMN 即清除标志（与 rewrite 路径一致）
      if (up === 'RENAME') renameTo = true;
      if (up === 'COLUMN' && renameTo) renameTo = false;
      if (up === 'TO' && renameTo) { renameTo = false; expectingTable = true; }
      continue;
    }

    // 期待表名时：`(`（子查询）/ `=`（PRAGMA 等号形式）保持期待，其余字符放弃
    if (expectingTable && ch !== '(' && ch !== '=' && !/\s/.test(ch)) {
      expectingTable = false;
    }
    i++;
  }
  return null;
}

/**
 * schema.sql 专用：把 SQL 中所有表名位置的裸标识符重写为 plg_<name>_<tbl>，
 * 同时显式拒绝核心表/其他插件表/其他插件 plg_ 前缀。
 * 返回重写后的 SQL；违规时抛出 Error（错误消息风格与 validatePrefixes 一致）。
 */
export function rewritePluginTableNames(sql, pluginName, prefix) {
  // 1) 快速通道：任何位置出现其他插件的 plg_ 前缀直接拒绝（含字符串/注释）。
  const foreignRe = /\bplg_[a-zA-Z0-9_-]+_/g;
  let m;
  while ((m = foreignRe.exec(sql)) !== null) {
    const fullPrefix = m[0];
    if (!fullPrefix.startsWith(prefix)) {
      throw new Error(`插件 ${pluginName} 不能访问表前缀 ${fullPrefix}（本插件只能访问 ${prefix} 开头的表）`);
    }
  }

  const ownTables = new Set(); // 本次 schema.sql 中 CREATE/ALTER TABLE 定义的裸表名

  let result = '';
  let i = 0;
  const n = sql.length;
  let expectingTable = false;
  let tableDef = false;       // 当前期待的表名属于 CREATE/ALTER TABLE 的定义
  let stmtFirst = true;
  let stmtKind = 'other';
  let pendingCreate = false;
  let pendingAlter = false;
  let renameTo = false;         // ALTER ... RENAME TO 的目标名位置（#167 💡6）
  let pragmaPending = false;
  let onConsumed = false;
  let inWith = false;
  let parenDepth = 0;
  const cteNames = new Set();

  const resetStatement = () => {
    expectingTable = false;
    tableDef = false;
    stmtFirst = true;
    stmtKind = 'other';
    pendingCreate = false;
    pendingAlter = false;
    renameTo = false;
    pragmaPending = false;
    onConsumed = false;
    inWith = false;
    cteNames.clear();
  };

  const formatPrefixed = (name) => {
    const full = prefix + name;
    const needsQuote = /[^a-zA-Z0-9_]/.test(full);
    return needsQuote ? `"${full}"` : full;
  };

  const resolveTableName = (name, isDef) => {
    const lower = name.toLowerCase();
    if (lower.startsWith(prefix)) return name;
    const foreignPrefix = /^plg_[a-zA-Z0-9_-]+_/.exec(lower)?.[0];
    if (foreignPrefix) {
      throw new Error(
        `插件 ${pluginName} 不能访问表 ${name}：前缀 ${foreignPrefix} 属于其他插件` +
        `（本插件只能访问 ${prefix} 开头的表）`
      );
    }
    if (CORE_TABLES.has(lower)) {
      throw new Error(
        `插件 ${pluginName} 不能访问表 ${name}：只允许访问 ${prefix} 开头的表` +
        `（核心表与其他插件表均不开放给插件）`
      );
    }
    if (isDef || ownTables.has(lower)) {
      if (isDef) ownTables.add(lower);
      return formatPrefixed(name);
    }
    throw new Error(
      `插件 ${pluginName} 不能访问表 ${name}：只允许访问 ${prefix} 开头的表` +
      `（核心表与其他插件表均不开放给插件）`
    );
  };

  while (i < n) {
    const ch = sql[i];
    const segmentStart = i;

    // 字符串字面量：整体复制
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      result += sql.slice(segmentStart, i);
      continue;
    }

    // 行注释 / 块注释：整体复制
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      result += sql.slice(segmentStart, i);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      result += sql.slice(segmentStart, i);
      continue;
    }

    // 引号标识符（"..."、`...`、[...]）
    if (ch === '"' || ch === '\`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      let ident = '';
      while (j < n && sql[j] !== close) { ident += sql[j]; j++; }
      if (j >= n) {
        // 未闭合，整体复制并结束
        result += sql.slice(segmentStart, n);
        break;
      }
      if (expectingTable) {
        const resolved = resolveTableName(ident, tableDef);
        expectingTable = false;
        tableDef = false;
        // resolveTableName 对需引号表名（含空格/连字符，或插件名为连字符型）已返回
        // 带双引号的完整名（formatPrefixed）；此时外层不应再包裹，否则输出双重引号，
        // SQLite 执行报 `near "plg_x_a b": syntax error`。
        if (resolved.startsWith('"') && resolved.endsWith('"')) {
          result += resolved;
        } else {
          result += ch + resolved + close;
        }
      } else {
        result += sql.slice(segmentStart, j + 1);
      }
      i = j + 1;
      continue;
    }

    if (ch === '(') { parenDepth++; result += ch; i++; continue; }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      if (expectingTable) { expectingTable = false; tableDef = false; }
      result += ch;
      i++;
      continue;
    }
    if (ch === ';') { resetStatement(); result += ch; i++; continue; }

    // 词（标识符/关键字）
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let word = '';
      while (j < n && /[A-Za-z0-9_]/.test(sql[j])) { word += sql[j]; j++; }
      const up = word.toUpperCase();
      const wordLower = word.toLowerCase();

      // WITH 子句（深度 0）：收集 CTE 名
      if (inWith && parenDepth === 0) {
        if (up === 'SELECT') {
          inWith = false;
        } else {
          let k = j;
          while (k < n && /\s/.test(sql[k])) k++;
          if (sql[k] === '(') cteNames.add(wordLower);
          else if (sql.startsWith('AS', k) && !/[A-Za-z0-9_]/.test(sql[k + 2] || '')) {
            cteNames.add(wordLower);
          }
        }
      }

      if (stmtFirst) {
        stmtFirst = false;
        if (FORBIDDEN_STATEMENTS.has(up)) {
          throw new Error(
            `插件 ${pluginName} 不允许执行 ${up} 语句（作用域为整个数据库，` +
            `插件沙箱只开放 ${prefix} 开头的表级操作）`
          );
        }
        if (up === 'CREATE') { pendingCreate = true; }
        if (up === 'ALTER') { pendingAlter = true; }
        if (up === 'WITH') { inWith = true; }
        if (up === 'PRAGMA') { pragmaPending = true; }
      }
      if (pendingCreate && up !== 'CREATE') {
        if (up === 'TABLE') tableDef = true;
        if (up !== 'UNIQUE' && up !== 'TEMP' && up !== 'TEMPORARY') {
          if (up === 'INDEX' || up === 'TRIGGER') stmtKind = 'index-trigger';
          pendingCreate = false;
        }
      }
      if (pendingAlter && up !== 'ALTER') {
        if (up === 'TABLE') tableDef = true;
        pendingAlter = false;
      }
      if (pragmaPending && up !== 'PRAGMA') {
        pragmaPending = false;
        if (PRAGMA_TABLE_NAMES.has(up)) expectingTable = true;
        result += word;
        i = j;
        continue;
      }

      if (expectingTable) {
        if (TABLE_MODIFIER_KEYWORDS.has(up)) {
          // 保持期待（IF NOT EXISTS / OR REPLACE 等）
        } else if (NON_TABLE_KEYWORDS.has(up)) {
          expectingTable = false;
          tableDef = false;
        } else if (cteNames.has(wordLower)) {
          expectingTable = false;
          tableDef = false;
        } else {
          result += resolveTableName(word, tableDef);
          expectingTable = false;
          tableDef = false;
          i = j;
          continue;
        }
      }

      if (TABLE_INTRO_KEYWORDS.has(up)) {
        expectingTable = true;
      }
      if (up === 'ON' && stmtKind === 'index-trigger' && !onConsumed) {
        onConsumed = true;
        expectingTable = true;
      }
      // ALTER ... RENAME TO <目标>（#167 💡6）：目标名与 FROM/INTO 同级校验/重写
      // RENAME COLUMN（SQLite 3.25+）的目标是列名而非表名，遇 COLUMN 即清除标志（review #169 inline #1）
      if (up === 'RENAME') renameTo = true;
      if (up === 'COLUMN' && renameTo) renameTo = false;
      if (up === 'TO' && renameTo) { renameTo = false; expectingTable = true; tableDef = true; }

      result += word;
      i = j;
      continue;
    }

    if (expectingTable && ch !== '(' && ch !== '=' && !/\s/.test(ch)) {
      expectingTable = false;
      tableDef = false;
    }
    result += ch;
    i++;
  }

  return result;
}

/** 构建命名空间存储 db */
function buildDbNamespace({ pluginName, prefix, ctx }) {
  const aliases = new Set();

  function getActual(alias) {
    return prefix + alias;
  }

  function validatePrefixes(sql) {
    // 1) 快速通道：任何位置出现其他插件的 plg_ 前缀直接拒绝（含字符串/注释里出现）。
    // 以本插件前缀开头（如 plg_<name>_deep_table 这类含下划线的表名）属本插件命名空间，放行。
    const foreignRe = /\bplg_[a-zA-Z0-9_-]+_/g;
    let m;
    while ((m = foreignRe.exec(sql)) !== null) {
      const fullPrefix = m[0];
      if (!fullPrefix.startsWith(prefix)) {
        throw new Error(`插件 ${pluginName} 不能访问表前缀 ${fullPrefix}`);
      }
    }

    // 2) 白名单：表名位置的标识符必须都是本插件前缀（核心表/其他插件表一律拒绝）
    const offender = findForeignTableName(sql, prefix);
    if (offender) {
      // __stmt: 哨兵（findForeignTableName 返回）= 语句级拒绝（VACUUM/ATTACH/DETACH 等），
      // 单独输出可读文案，避免误导插件作者以为是表名问题（review #169 💡2）
      const stmtMatch = /^__stmt:([A-Za-z]+)$/.exec(offender);
      if (stmtMatch) {
        throw new Error(
          `插件 ${pluginName} 不允许执行 ${stmtMatch[1]} 语句：作用域为整个数据库` +
          `（可整库导出或挂载外部库，禁止在插件内执行）`
        );
      }
      const foreignPrefix = /^plg_[a-zA-Z0-9_-]+_/.exec(offender.toLowerCase())?.[0];
      if (foreignPrefix) {
        throw new Error(
          `插件 ${pluginName} 不能访问表 ${offender}：前缀 ${foreignPrefix} 属于其他插件` +
          `（本插件只能访问 ${prefix} 开头的表）`
        );
      }
      throw new Error(
        `插件 ${pluginName} 不能访问表 ${offender}：只允许访问 ${prefix} 开头的表` +
        `（核心表与其他插件表均不开放给插件）`
      );
    }
  }

  function rewrite(sql) {
    const sorted = Array.from(aliases).sort((a, b) => b.length - a.length);
    for (const alias of sorted) {
      const actual = getActual(alias);
      // 仅当实际表名含非标识符字符（如连字符插件的 plg_emoji-notes_notes）才加双引号；
      // 否则不加——避免把 SQL 里已带引号的别名（如 events 的 "store"）套成双重引号导致语法错误。
      const needsQuote = /[^a-zA-Z0-9_]/.test(actual);
      const replacement = needsQuote ? `"${actual}"` : actual;
      sql = sql.replace(new RegExp(`\\b${alias}\\b`, 'g'), replacement);
    }
    return sql;
  }

  function runStmt(alias, sql, params, method) {
    if (typeof sql !== 'string') throw new Error('SQL 必须是字符串');
    let rewritten = rewrite(sql);
    validatePrefixes(rewritten);
    if (method === 'run') {
      if (params !== undefined) return ctx.storage.run(rewritten, params);
      return ctx.storage.run(rewritten);
    }
    if (method === 'get') {
      if (params !== undefined) return ctx.storage.get(rewritten, params);
      return ctx.storage.get(rewritten);
    }
    // method === 'all'
    if (params !== undefined) return ctx.storage.query(rewritten, params);
    return ctx.storage.query(rewritten);
  }

  function createHandle(alias) {
    return {
      run(sql, params) {
        return runStmt(alias, sql, params, 'run');
      },
      get(sql, params) {
        return runStmt(alias, sql, params, 'get');
      },
      all(sql, params) {
        return runStmt(alias, sql, params, 'all');
      },
      exec(sql) {
        if (typeof sql !== 'string') throw new Error('SQL 必须是字符串');
        let rewritten = rewrite(sql);
        validatePrefixes(rewritten);
        return ctx.storage.exec(rewritten);
      },
      transaction(fn) {
        return ctx.storage.transaction(() => fn(createHandle(alias)))();
      },
    };
  }

  return {
    table(alias) {
      if (typeof alias !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
        throw new Error(`非法表别名: ${alias}`);
      }
      aliases.add(alias);
      return createHandle(alias);
    },
    exec(sql) {
      if (typeof sql !== 'string') throw new Error('SQL 必须是字符串');
      let rewritten = rewrite(sql);
      validatePrefixes(rewritten);
      return ctx.storage.exec(rewritten);
    },
  };
}

/** 构建 VRChat API 调用对象 */
function buildVrchatApi({ ctx, log }) {
  return {
    async fetch(path, options = {}) {
      const method = options.method || 'GET';
      const body = options.body ?? null;

      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error('api.vrchat.fetch 只接受以 "/" 开头的 VRChat API 路径');
      }
      if (!ctx.api) {
        throw new Error('VRChat API 客户端尚未初始化');
      }
      if (!ctx.rateLimiter) {
        throw new Error('限流器尚未初始化');
      }

      return ctx.rateLimiter.execute(async () => {
        const res = await ctx.api._request(method, path, body);
        if (res.status >= 200 && res.status < 300) {
          return res.data;
        }
        const err = new Error(`VRChat API 请求失败: ${res.status} ${path}`);
        err.status = res.status;
        err.response = res.data;
        throw err;
      });
    },

    async uploadImageFile(fileBuffer, filename, params) {
      if (!ctx.api) throw new Error('VRChat API 客户端尚未初始化');
      if (!ctx.rateLimiter) throw new Error('限流器尚未初始化');
      return ctx.rateLimiter.execute(() => ctx.api.uploadImageFile(fileBuffer, filename, params));
    },

    async uploadPrint(fileBuffer, filename, { note, timestamp } = {}) {
      if (!ctx.api) throw new Error('VRChat API 客户端尚未初始化');
      if (!ctx.rateLimiter) throw new Error('限流器尚未初始化');
      return ctx.rateLimiter.execute(() => ctx.api.uploadPrint(fileBuffer, filename, { note, timestamp }));
    },

    async uploadGalleryImage(fileBuffer, filename) {
      if (!ctx.api) throw new Error('VRChat API 客户端尚未初始化');
      if (!ctx.rateLimiter) throw new Error('限流器尚未初始化');
      return ctx.rateLimiter.execute(() => ctx.api.uploadGalleryImage(fileBuffer, filename));
    },

    async download(url) {
      if (!ctx.api) throw new Error('VRChat API 客户端尚未初始化');
      if (!ctx.rateLimiter) throw new Error('限流器尚未初始化');
      return ctx.rateLimiter.execute(() => ctx.api.downloadFile(url));
    },
  };
}
