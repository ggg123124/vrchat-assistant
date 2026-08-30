<script setup>
import { computed } from 'vue';
import { setView } from '../store.js';

const props = defineProps({ view: { type: String, default: '' } });

const labels = {
  favorites: '收藏', logs: '游戏日志', players: '房间玩家列表', notifications: '通知',
  avatars: '我的模型', worlds: '世界记录', charts: '图表', moderation: '屏蔽管理',
  tools: '工具', search: '搜索', open: '直接打开',
};
const title = computed(() => labels[props.view] || props.view);
</script>

<template>
  <div>
    <div class="view-title">{{ title }}</div>
    <div class="empty">
      <i class="pi pi-sparkles" style="font-size: 28px; display: block; margin-bottom: 10px"></i>
      该视图将在后续迭代中迁移至新 UI
      <small>旧版功能仍完整可用（{{ title }} 数据与接口不变）</small>
    </div>
    <div style="display:flex; justify-content:center">
      <Button label="回到动态" icon="pi pi-bolt" size="small" @click="setView('feed')" />
    </div>
  </div>
</template>
