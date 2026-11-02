// 只保留 woff2：primeicons 的 @font-face 列了 eot/woff2/woff/ttf/svg 五种格式，
// viteSingleFile 的 assetsInlineLimit=1e8 会把**每一种**都 base64 内联进 index.html
// （woff 110KB + ttf 110KB 纯属 2010 年代兜底，现代浏览器一律用 woff2）。
// 在 CSS 源码层把 src 收窄成单格式，内联阶段就只剩 woff2。
export function primeiconsWoff2Only() {
  return {
    name: 'primeicons-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('primeicons') || !id.endsWith('.css')) return null;
      const out = code
        // 第一条 eot 兜底
        .replace(/src:\s*url\(['"]?\.\/fonts\/primeicons\.eot['"]?\);\s*/g, '')
        // 第二条多格式列表 → 只留 woff2
        .replace(
          /src:\s*url\(['"]?\.\/fonts\/primeicons\.eot[^;]*;/g,
          "src: url('./fonts/primeicons.woff2') format('woff2');"
        );
      return out === code ? null : { code: out, map: null };
    },
  };
}
