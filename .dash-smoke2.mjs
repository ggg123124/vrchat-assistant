import register from './plugins/official/web-dashboard/index.js';
const routes=[];
const api={http:{registerRoute(r){routes.push(`${r.method} ${r.path}`)}},consume:async()=>[],tools:{call:async()=>({})},vrchat:{fetch:async()=>[]},log(){}};
const dispose=register(api);
const seen=new Set();const dups=[];
for(const r of routes){if(seen.has(r))dups.push(r);seen.add(r)}
console.log(JSON.stringify({routes:routes.length,dups,disposer:typeof dispose}));
dispose?.();
