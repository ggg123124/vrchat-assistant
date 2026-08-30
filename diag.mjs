import { PluginLoader } from './core/plugin-loader.js';
import * as registry from './core/registry.js';
import { ctx } from './core/server-context.js';
const loader = new PluginLoader({ registry, ctx, log: console.log });
const res = await loader.loadAll();
console.log('Loader res:', res);
for (const [k, v] of loader.plugins.entries()) {
  console.log(k, '->', v.status, v.error || '');
}
