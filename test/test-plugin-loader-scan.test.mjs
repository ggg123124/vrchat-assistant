/**
 * test-plugin-loader-scan.mjs — 插件静态扫描：破坏性工具名前缀契约（docs/PLUGIN-API.md §7）
 *
 * 覆盖：
 *   1. 工具名匹配破坏性前缀且声明 destructive: true → 放行
 *   2. 匹配前缀但未声明（或 destructive: false）→ 静态扫描报错拒绝加载
 *   3. 非匹配前缀（x_remove_creator）、registerTool(def) 标识符参数、字符串/注释中的名字 → 不误报
 *   4. 回归：官方插件目录全部通过静态扫描（防止契约收紧误伤现有插件）
 *
 * 用法：node test/test-plugin-loader-scan.mjs
 * 无需 VRChat 凭据 / 网络，可离线运行。退出码 0=全部通过。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginLoader } from '../core/plugin-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
function ok(name) { passed++; console.log('  ✅ ' + name); }

const loader = new PluginLoader({ registry: {}, ctx: {}, log: () => {} });
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'plg-scan-'));

function makePlugin(dirName, indexJs) {
  const dir = path.join(tmpRoot, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.js'), indexJs, 'utf-8');
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: dirName, version: '1.0.0', description: 'test' }),
    'utf-8'
  );
  return {
    name: dirName,
    dir,
    entryFile: path.join(dir, 'index.js'),
    schemaFile: null,
    manifestFile: path.join(dir, 'plugin.json'),
  };
}

try {
  console.log('── 1. 匹配破坏性前缀 + destructive: true → 放行 ──');
  {
    const p = makePlugin('good-a', `
      export default function register(api) {
        api.registerTool({
          name: 'remove_stuff',
          destructive: true,
          description: '清理数据',
          inputSchema: { type: 'object', properties: { id: { type: 'number' } } },
        });
        api.registerTool({
          name: 'get_stuff',
          description: '查询',
          inputSchema: { type: 'object', properties: { destructive: { type: 'boolean' }, name: { type: 'string' } } },
        });
      }
    `);
    assert.deepEqual(loader._staticScan(p), [], 'declared destructive 的工具与嵌套键不应报错');
    ok('remove_stuff(destructive:true) 与 inputSchema 嵌套键放行');
  }

  console.log('── 2. 匹配前缀但未声明 destructive → 拒绝 ──');
  {
    const p1 = makePlugin('bad-a', `
      export default function register(api) {
        api.registerTool({ name: 'remove_stuff', description: '清理数据', inputSchema: {} });
      }
    `);
    const e1 = loader._staticScan(p1);
    // entryFile 与目录 .js 遍历有重叠（index.js 会被扫两次），同一错误可能出现多条
    assert.ok(e1.length >= 1, '应至少 1 条错误');
    assert.ok(
      e1.every(e => e.includes('remove_stuff') && e.includes('破坏性前缀 "remove_"') && e.includes('destructive')),
      `错误内容应指出前缀与 destructive: ${e1.join('; ')}`
    );
    ok('remove_stuff 未声明 destructive → 静态扫描拒绝');

    const p2 = makePlugin('bad-b', `
      export default function register(api) {
        api.registerTool({ name: 'delete_all', destructive: false, description: 'x', inputSchema: {} });
      }
    `);
    const e2 = loader._staticScan(p2);
    assert.ok(e2.length >= 1, 'destructive:false 同样应拒绝');
    ok('delete_all 声明 destructive:false → 静态扫描拒绝');
  }

  console.log('── 3. 非匹配场景不误报 ──');
  {
    const p = makePlugin('good-b', `
      export default function register(api) {
        api.registerTool({ name: 'x_remove_creator', description: '移除 X 博主', inputSchema: {} });
        const def = { name: 'remove_other', description: '标识符参数', inputSchema: {} };
        api.registerTool(def);
        const note = '工具 remove_something 只是字符串';
        const s = 'api.registerTool({ name: "remove_in_string" })';
        const t = \`api.registerTool({ name: 'remove_in_template' })\`;
        // api.registerTool({ name: 'remove_comment' }) 注释中的不扫描
      }
    `);
    assert.deepEqual(loader._staticScan(p), [], 'x_ 前缀/标识符参数/字符串/注释不应报错');
    ok('x_remove_creator、registerTool(def)、字符串/模板串/注释中的名字不误报');
  }

  console.log('── 4. 官方插件全量静态扫描回归 ──');
  {
    const officialDir = path.join(__dirname, '..', 'plugins', 'official');
    const names = readdirSync(officialDir);
    let scanned = 0;
    for (const name of names) {
      const dir = path.join(officialDir, name);
      if (!existsSync(path.join(dir, 'plugin.json')) && !existsSync(path.join(dir, 'index.js'))) continue;
      const plugin = {
        name,
        dir,
        entryFile: path.join(dir, 'index.js'),
        schemaFile: path.join(dir, 'schema.sql'),
        manifestFile: path.join(dir, 'plugin.json'),
      };
      const errs = loader._staticScan(plugin);
      assert.deepEqual(errs, [], `官方插件 ${name} 静态扫描不应报错: ${errs.join('; ')}`);
      scanned++;
    }
    ok(`官方插件 ${scanned} 个全部通过静态扫描`);
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n🎉 全部 ${passed} 项通过`);
