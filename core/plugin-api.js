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
