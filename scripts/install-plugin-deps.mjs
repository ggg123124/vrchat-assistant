// 安装官方插件自带的依赖（若插件目录内有 package.json，则对该目录执行 npm ci --prefix）。
// 用途：仓库根 `npm run install-plugins`，或在 CI 里 `npm ci`（根依赖）之后调用，保证每个带第三方依赖的插件可加载。
// 无 package.json 的插件直接跳过（零依赖插件如 auth-guard/booth 等）。跨平台（Win/Linux/mac/NAS/容器）。
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const OFFICIAL = path.join(repoRoot, 'plugins', 'official');
const LOCAL = path.join(repoRoot, 'plugins', 'local');

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function installPluginsIn(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const name of readdirSync(root)) {
    const dir = path.join(root, name);
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) continue; // 零依赖插件，无 package.json，跳过
    console.log(`[install-plugins] npm ci --prefix ${path.relative(repoRoot, dir)}`);
    // Windows 上 npm 是 npm.cmd，不能直接 CreateProcess 启动；shell:true 走 cmd /c（Unix 走 sh -c），跨平台一致
    execFileSync(npmBin, ['ci', '--prefix', dir], { stdio: 'inherit', cwd: repoRoot, shell: true });
    count++;
  }
  return count;
}

/**
 * 前端子目录构建（issue #186 方案 A）：dist 已出库，安装期需为带前端源码的插件构建产物。
 * 约定：插件目录下的 `ui/package.json` = 前端子目录（构建命令 `npm run build --prefix <ui>`）。
 * 失败只 warn + 打印手动命令，不阻断其他插件安装（前端产物缺失时服务回退旧版 UI 仍可用）。
 */
function buildPluginUisIn(root) {
  if (!existsSync(root)) return 0;
  let count = 0;
  for (const name of readdirSync(root)) {
    const uiDir = path.join(root, name, 'ui');
    if (!existsSync(path.join(uiDir, 'package.json'))) continue;
    const rel = path.relative(repoRoot, uiDir);
    const built = path.join(uiDir, 'dist', 'index.html');
    try {
      console.log(`[install-plugins] npm ci --prefix ${rel}`);
      execFileSync(npmBin, ['ci', '--prefix', uiDir], { stdio: 'inherit', cwd: repoRoot, shell: true });
      console.log(`[install-plugins] npm run build --prefix ${rel}`);
      execFileSync(npmBin, ['run', 'build', '--prefix', uiDir], { stdio: 'inherit', cwd: repoRoot, shell: true });
      count++;
    } catch (e) {
      // 降级可见：前端产物属增强，构建失败不阻断插件安装（运行时回退旧版 UI 并有启动告警）
      console.warn(`[install-plugins] [警告] 前端构建失败（不阻断）: ${rel} — ${String((e && e.message) || e)}`);
      console.warn(`[install-plugins] 手动修复: npm run build:dashboard`);
      if (!existsSync(built)) console.warn(`[install-plugins] 注意: ${path.relative(repoRoot, built)} 不存在，服务将回退旧版 UI`);
    }
  }
  return count;
}

let n = 0;
n += installPluginsIn(OFFICIAL);
n += installPluginsIn(LOCAL);
const uis = buildPluginUisIn(OFFICIAL) + buildPluginUisIn(LOCAL);
console.log(`[install-plugins] 完成，共安装 ${n} 个插件依赖${uis ? `，构建 ${uis} 个前端产物` : ''}。`);
