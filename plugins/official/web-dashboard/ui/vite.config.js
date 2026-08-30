import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 单文件构建：所有 JS/CSS 打进 index.html → 路由只需服务一个文件（免静态资源鉴权白名单）
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  build: {
    outDir: 'dist',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 5000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
