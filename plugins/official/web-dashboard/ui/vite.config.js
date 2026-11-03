import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { primeiconsWoff2Only } from './font-subset-plugin.js';

// 单文件构建：所有 JS/CSS 打进 index.html → 路由只需服务一个文件（免静态资源鉴权白名单）
export default defineConfig({
  // 顺序很重要：字体裁剪必须在 viteSingleFile 内联之前生效（enforce:'pre' 保证先跑）
  plugins: [primeiconsWoff2Only(), vue(), viteSingleFile()],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 5000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
