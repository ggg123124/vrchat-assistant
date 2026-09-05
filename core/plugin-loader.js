/**
 * Plugin Loader — 插件扫描、加载、依赖排序、热加载与失败隔离。
 *
 * 插件目录：
 *   - plugins/official/
 *   - plugins/local/
 *   - $VRC_MONITOR_PLUGINS_DIR
 *
 * 目录内每个子目录（或单个 .js 文件）即为一个插件。
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPluginApi } from './plugin-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_DIR_NAMES = ['plugins/official', 'plugins/local'];
const SENSITIVE_ENV_PATTERNS = [
  /process\.env\.[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD|COOKIE|AUTH)[A-Z_]*/i,
];
const SENSITIVE_FILE_PATTERNS = [
  /credentials\.json/i,
  /auth_cookie\.txt/i,
  /secure_secrets/i,
];
const FORBIDDEN_IMPORT_PATTERNS = [
  /(?:import|from)\s+['"]core\//,
  /(?:import|from)\s+['"]\.\.?\/core\//,
  /(?:import|from)\s+['"]start-monitor/,
  /import\(['"]core\//,
  /import\(['"]\.\.?\/core\//,
  /import\(['"]start-monitor/,
];

export class PluginLoader {
  constructor({ registry, ctx, log, notifier }) {
    this.registry = registry;
    this.ctx = ctx;
    this.log = log;
    this.notifier = notifier;
    this.plugins = new Map(); // name -> plugin record
    this.services = new Map();
    this.serviceOwners = new Map();
    this.watchers = [];
    this.rootDirs = [];
    this._reloadTimers = new Map();
  }

  /** 收集插件根目录 */
  _collectRootDirs() {
    const dirs = [];
    const add = (dir) => {
      if (existsSync(dir)) dirs.push(dir);
    };
    for (const rel of PLUGIN_DIR_NAMES) {
      add(path.resolve(__dirname, '..', rel));
    }
    if (process.env.VRC_MONITOR_PLUGINS_DIR) {
      add(path.resolve(process.env.VRC_MONITOR_PLUGINS_DIR));
    }
    return dirs;
  }

  /** 扫描单个插件根目录，返回候选插件信息列表 */
  _scanDir(dir) {
    const candidates = [];
    if (!existsSync(dir)) return candidates;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        candidates.push({
          name: null, // 从 plugin.json 读取
          dir: full,
          entryFile: path.join(full, 'index.js'),
          schemaFile: path.join(full, 'schema.sql'),
          manifestFile: path.join(full, 'plugin.json'),
          type: 'dir',
        });
      } else if (st.isFile() && name.endsWith('.js')) {
        candidates.push({
          name: path.basename(name, '.js'),
          dir,
          entryFile: full,
          schemaFile: null,
          manifestFile: null,
          type: 'file',
        });
      }
    }
    return candidates;
  }

  /** 静态扫描插件代码 */
  _staticScan(plugin) {
    const files = [plugin.entryFile];
    if (existsSync(plugin.dir)) {
      try {
        for (const f of readdirSync(plugin.dir)) {
          if (f.endsWith('.js')) files.push(path.join(plugin.dir, f));
        }
      } catch { /* ignore */ }
    }

    const errors = [];
    for (const file of files) {
      let code;
      try {
        code = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }

      for (const p of FORBIDDEN_IMPORT_PATTERNS) {
        if (p.test(code)) {
          errors.push(`文件 ${path.basename(file)} 存在禁止的核心内部导入`);
        }
      }

      for (const p of SENSITIVE_ENV_PATTERNS) {
        if (p.test(code)) {
          errors.push(`文件 ${path.basename(file)} 读取了敏感环境变量`);
        }
      }

      for (const p of SENSITIVE_FILE_PATTERNS) {
        if (p.test(code)) {
          errors.push(`文件 ${path.basename(file)} 访问了敏感文件`);
        }
      }

      if (/require\(['"]child_process['"]\)/.test(code) || /import\s+.*?['"]child_process['"]/.test(code)) {
        errors.push(`文件 ${path.basename(file)} 使用了 child_process`);
      }

      if (/process\.exit\(/.test(code)) {
        errors.push(`文件 ${path.basename(file)} 使用了 process.exit`);
      }
    }

    return errors;
  }

  /** 读取并校验清单 */
  _loadManifest(plugin) {
    if (plugin.type === 'file') {
      return { name: plugin.name, version: '0.0.0', description: '' };
    }
    const mf = plugin.manifestFile;
    if (!existsSync(mf)) {
      throw new Error('缺少 plugin.json（单文件形态除外）');
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(mf, 'utf-8'));
    } catch (err) {
      throw new Error(`plugin.json 解析失败: ${err.message}`);
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error('plugin.json 缺少 name 字段');
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
      throw new Error('plugin.json 缺少 version 字段');
    }
    if (!manifest.description || typeof manifest.description !== 'string') {
      throw new Error('plugin.json 缺少 description 字段');
    }
    if (!/^[a-z0-9-]+$/.test(manifest.name)) {
      throw new Error(`plugin.json name 只能包含小写字母、数字、中划线: ${manifest.name}`);
    }
    plugin.name = manifest.name;
    plugin.manifest = manifest;
    return manifest;
  }

  /** 依赖拓扑排序，返回 {order, cyclePlugins} */
  _topoSort(candidates) {
    const enabled = candidates.filter(p => !p._error);
    const map = new Map();
    for (const p of enabled) map.set(p.name, p);

    const order = [];
    const visiting = new Set();
    const visited = new Set();
    const cyclePlugins = new Set();

    const visit = (p, stack) => {
      if (visited.has(p.name)) return;
      if (visiting.has(p.name)) {
        // 成环：从 stack 中第一次出现 p.name 的位置到末尾都是环上节点
        const idx = stack.indexOf(p.name);
        for (let i = idx; i < stack.length; i++) cyclePlugins.add(stack[i]);
        return;
      }
      visiting.add(p.name);
      const deps = p.manifest?.depends || [];
      for (const dep of deps) {
        const depPlugin = map.get(dep);
        if (!depPlugin) {
          p._error = `插件 ${p.name} 依赖的 ${dep} 未安装`;
          continue;
        }
        visit(depPlugin, stack.concat(p.name));
      }
      visiting.delete(p.name);
      visited.add(p.name);
      order.push(p.name);
    };

    for (const p of enabled) {
      if (!visited.has(p.name)) visit(p, []);
    }

    return { order, cyclePlugins };
  }

  /** 执行 schema.sql（支持裸表名自动重写为 plg_<name>_<tbl>） */
  _applySchema(plugin) {
    const { ctx } = this;
    if (!plugin.schemaFile || !existsSync(plugin.schemaFile)) return;
    let sql = readFileSync(plugin.schemaFile, 'utf-8');

    // 拒绝访问其他插件的 plg_ 前缀
    const prefix = `plg_${plugin.name}_`;
    const foreignRe = /\bplg_[a-zA-Z0-9_-]+_/g;
    let m;
    while ((m = foreignRe.exec(sql)) !== null) {
      if (m[0] !== prefix) {
        throw new Error(`schema.sql 中表前缀 ${m[0]} 不属于本插件 ${plugin.name}`);
      }
    }

    // 把 CREATE TABLE / ALTER TABLE 后的裸表名重写为带前缀的表名
    const tableRe = /((?:CREATE TABLE|ALTER TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?)([a-zA-Z0-9_]+)/gi;
    sql = sql.replace(tableRe, (match, pre, tableName) => {
      if (tableName.startsWith('plg_')) return match;
      const full = prefix + tableName;
      // 仅当完整表名含非标识符字符（连字符插件名）才加双引号，避免非必需引号
      const needsQuote = /[^a-zA-Z0-9_]/.test(full);
      return `${pre}${needsQuote ? `"${full}"` : full}`;
    });

    ctx.storage.exec(sql);
  }

  /** 检查插件 package.json 依赖是否已安装（不自动安装，缺依赖则抛出错误） */
  _checkPluginDeps(plugin) {
    if (!plugin.dir || !existsSync(plugin.dir)) return;
    const pkgPath = path.join(plugin.dir, 'package.json');
    if (!existsSync(pkgPath)) return;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      return;
    }
    const deps = pkg.dependencies;
    if (!deps || typeof deps !== 'object' || Object.keys(deps).length === 0) return;

    const req = createRequire(pkgPath);
    for (const dep of Object.keys(deps)) {
      try {
        req.resolve(dep);
      } catch {
        throw new Error(`插件 ${plugin.name} 缺少依赖 ${dep}，请在仓库根执行: npm ci --prefix plugins/official/${plugin.name}`);
      }
    }
  }

  /** 加载单个插件 */
  async _loadPlugin(plugin) {
    const { registry, ctx, services, serviceOwners, log } = this;

    // 静态扫描
    const scanErrors = this._staticScan(plugin);
    if (scanErrors.length > 0) {
      throw new Error(`静态扫描失败: ${scanErrors.join('; ')}`);
    }

    // 导入插件模块（加时间戳避免 ESM 缓存导致热加载拿不到最新代码）
    const moduleUrl = `${pathToFileURL(plugin.entryFile).href}?t=${Date.now()}`;
    let mod;
    try {
      mod = await import(moduleUrl);
    } catch (err) {
      throw new Error(`模块导入失败: ${err.message}`);
    }

    const registerFn = mod.default;
    if (typeof registerFn !== 'function') {
      throw new Error('index.js 必须默认导出一个 register(api) 函数');
    }

    // 构建 API 并执行注册
    const api = buildPluginApi(plugin.name, { registry, ctx, services, serviceOwners, log });
    this.registry.removePluginTools(plugin.name);
    const result = await registerFn(api);

    plugin.dispose = typeof result === 'function' ? result : null;
    plugin.loaded = true;

    this.log(`插件已加载: ${plugin.name} v${plugin.manifest?.version || '0.0.0'}`);
  }

  /** 禁用插件并记录错误 */
  _setError(plugin, error) {
    plugin.status = 'error';
    plugin.error = error;
    plugin.loaded = false;
    this.registry.removePluginTools(plugin.name);
    this.log(`❌ 插件加载失败 [${plugin.name}]: ${error}`);
  }

  /** 加载所有插件 */
  async loadAll() {
    this.rootDirs = this._collectRootDirs();
    const candidates = [];
    for (const dir of this.rootDirs) {
      candidates.push(...this._scanDir(dir));
    }

    // 读取清单
    for (const plugin of candidates) {
      try {
        this._loadManifest(plugin);
        plugin.status = 'pending';
      } catch (err) {
        plugin.name = plugin.name || path.basename(plugin.dir || plugin.entryFile);
        plugin.status = 'error';
        plugin.error = err.message;
      }
    }

    // 校验依赖缺失
    const byName = new Map();
    for (const p of candidates) {
      if (!p._error) byName.set(p.name, p);
    }
    for (const p of candidates) {
      if (p.status === 'error') continue;
      const deps = p.manifest?.depends || [];
      for (const dep of deps) {
        if (!byName.has(dep)) {
          p.status = 'error';
          p.error = `请先安装插件 ${dep}`;
        }
      }
    }

    // 拓扑排序
    const { order, cyclePlugins } = this._topoSort(candidates);
    for (const p of candidates) {
      if (cyclePlugins.has(p.name)) {
        p.status = 'error';
        p.error = `插件依赖成环: ${p.name}`;
        this.plugins.set(p.name, p);
      }
    }

    // 按顺序加载
    for (const name of order) {
      const plugin = candidates.find(p => p.name === name);
      if (plugin.status === 'error') continue;
      try {
        this._checkPluginDeps(plugin);
        this._applySchema(plugin);
        await this._loadPlugin(plugin);
        plugin.status = 'loaded';
        this.plugins.set(plugin.name, plugin);
      } catch (err) {
        this._setError(plugin, err.message);
        this.plugins.set(plugin.name, plugin);
      }
    }
  }

  /** 按插件名卸载 */
  _unloadPlugin(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    this.log(` 卸载插件: ${name}`);
    if (plugin.dispose) {
      try { plugin.dispose(); } catch (err) { this.log(`插件 ${name} dispose 出错: ${err.message}`); }
    }
    this.registry.removePluginTools(name);
    for (const [key, route] of this.ctx.httpRoutes?.entries() || []) {
      if (route.pluginName === name) this.ctx.httpRoutes.delete(key);
    }
    for (const [svc, owner] of this.serviceOwners.entries()) {
      if (owner === name) {
        this.services.delete(svc);
        this.serviceOwners.delete(svc);
      }
    }
    plugin.status = 'disabled';
  }

  /** 按插件名重新加载 */
  async _reloadPlugin(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    // 插件目录已删除 -> 直接卸载
    if (!existsSync(plugin.dir)) {
      this._unloadPlugin(name);
      return;
    }

    this.log(` 热重载插件: ${name}`);

    // 快照旧版工具，新版失败时回滚
    const oldTools = this.registry.getPluginTools().filter(t => t.origin === name);
    const oldDispose = plugin.dispose;

    if (plugin.dispose) {
      try { plugin.dispose(); } catch (err) { this.log(`插件 ${name} dispose 出错: ${err.message}`); }
    }
    this.registry.removePluginTools(name);
    for (const [key, route] of this.ctx.httpRoutes?.entries() || []) {
      if (route.pluginName === name) this.ctx.httpRoutes.delete(key);
    }
    // 移除该插件提供的服务
    const oldServices = [];
    for (const [svc, owner] of this.serviceOwners.entries()) {
      if (owner === name) {
        oldServices.push({ name: svc, fn: this.services.get(svc) });
        this.services.delete(svc);
        this.serviceOwners.delete(svc);
      }
    }

    try {
      await this._loadPlugin(plugin);
      plugin.status = 'loaded';
      plugin.error = null;
    } catch (err) {
      this.log(` 插件热重载失败 [${name}]: ${err.message}，回滚旧版`);
      for (const t of oldTools) {
        this.registry.getPluginTools().push(t);
        this.registry.getPluginToolMap().set(t.name, t);
      }
      for (const { name: svcName, fn } of oldServices) {
        this.services.set(svcName, fn);
        this.serviceOwners.set(svcName, name);
      }
      plugin.dispose = oldDispose;
      plugin.status = 'loaded';
      plugin.error = `热重载失败，已回滚旧版: ${err.message}`;
    }
  }

  /** 按路径加载一个新插件（热新增用） */
  async _loadNewPlugin(pluginDir) {
    let candidate;
    const st = statSync(pluginDir);
    if (st.isDirectory()) {
      candidate = {
        name: null,
        dir: pluginDir,
        entryFile: path.join(pluginDir, 'index.js'),
        schemaFile: path.join(pluginDir, 'schema.sql'),
        manifestFile: path.join(pluginDir, 'plugin.json'),
        type: 'dir',
      };
    } else if (st.isFile() && pluginDir.endsWith('.js')) {
      candidate = {
        name: path.basename(pluginDir, '.js'),
        dir: path.dirname(pluginDir),
        entryFile: pluginDir,
        schemaFile: null,
        manifestFile: null,
        type: 'file',
      };
    } else {
      return;
    }

    try {
      this._loadManifest(candidate);
      if (this.plugins.has(candidate.name)) {
        this.log(`⚠️ 插件 ${candidate.name} 已存在，跳过新插件加载`);
        return;
      }
      this._checkPluginDeps(candidate);
      this._applySchema(candidate);
      await this._loadPlugin(candidate);
      candidate.status = 'loaded';
      this.plugins.set(candidate.name, candidate);
    } catch (err) {
      candidate.status = 'error';
      candidate.error = err.message;
      this.plugins.set(candidate.name, candidate);
      this.log(`❌ 插件加载失败 [${candidate.name || candidate.dir}]: ${err.message}`);
    }
  }

  /** 启动目录监听 */
  watch() {
    for (const dir of this.rootDirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { recursive: true }, async (event, filename) => {
          if (!filename) return;
          const full = path.join(dir, filename);
          // 只关心 .js / .json / .sql 变更
          if (!/\.(js|json|sql)$/.test(filename)) return;

          // 查找受影响的插件
          let affectedPlugin = null;
          for (const [name, plugin] of this.plugins.entries()) {
            if (full.startsWith(plugin.dir + path.sep) || full === plugin.entryFile) {
              affectedPlugin = name;
              break;
            }
          }

          if (affectedPlugin) {
            // 防抖：同一个插件 300ms 内多次变更只重载一次
            if (this._reloadTimers.has(affectedPlugin)) clearTimeout(this._reloadTimers.get(affectedPlugin));
            this._reloadTimers.set(affectedPlugin, setTimeout(() => {
              this._reloadPlugin(affectedPlugin);
              this._reloadTimers.delete(affectedPlugin);
            }, 300));
          } else {
            // 未找到已加载插件，尝试作为新插件加载
            const firstSegment = filename.split(path.sep)[0];
            const pluginDir = path.join(dir, firstSegment);
            if (existsSync(pluginDir)) {
              this._loadNewPlugin(pluginDir);
            }
          }
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.log(`️ 插件目录监听失败 ${dir}: ${err.message}`);
      }
    }
  }

  /** 检查是否注册了指定服务 */
  hasService(name) {
    return this.services.has(name);
  }

  /** 调用已注册的服务 */
  consume(name, ...args) {
    if (!this.services.has(name)) {
      throw new Error(`服务 ${name} 不存在`);
    }
    return this.services.get(name)(...args);
  }

  /** 返回插件状态数组（供 /health） */
  getStatus() {
    const status = [];
    for (const plugin of this.plugins.values()) {
      const s = {
        name: plugin.name,
        version: plugin.manifest?.version || '0.0.0',
        status: plugin.status || 'unknown',
        schemaVersion: 'applied',
      };
      if (plugin.error) s.error = plugin.error;
      status.push(s);
    }
    return status;
  }
}
