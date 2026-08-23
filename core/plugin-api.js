/**
 * Plugin API v1 — 为插件提供与核心交互的 6 个 API 表面。
 *
 * buildPluginApi(pluginName, { registry, ctx, services, serviceOwners, log })
 */

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

/** 构建命名空间存储 db */
function buildDbNamespace({ pluginName, prefix, ctx }) {
  const aliases = new Set();

  function getActual(alias) {
    return prefix + alias;
  }

  function validatePrefixes(sql) {
    const re = /\bplg_[a-zA-Z0-9_-]+_/g;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const fullPrefix = m[0];
      if (fullPrefix !== prefix) {
        throw new Error(`插件 ${pluginName} 不能访问表前缀 ${fullPrefix}`);
      }
    }
  }

  function rewrite(sql) {
    const sorted = Array.from(aliases).sort((a, b) => b.length - a.length);
    for (const alias of sorted) {
      const actual = getActual(alias);
      sql = sql.replace(new RegExp(`\\b${alias}\\b`, 'g'), actual);
    }
    return sql;
  }

  function runStmt(alias, sql, params, method) {
    if (typeof sql !== 'string') throw new Error('SQL 必须是字符串');
    let rewritten = rewrite(sql);
    validatePrefixes(rewritten);
    const stmt = ctx.storage.db.prepare(rewritten);
    if (params !== undefined) return stmt[method](params);
    return stmt[method]();
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
        return ctx.storage.db.exec(rewritten);
      },
      transaction(fn) {
        return ctx.storage.db.transaction(() => fn(createHandle(alias)))();
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
      return ctx.storage.db.exec(rewritten);
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
        throw new Error(`VRChat API 请求失败: ${res.status} ${path}`);
      });
    },
  };
}
