<script setup>
// 信用等级徽章（VRCX 风格）：描边徽章 + 盾牌图标，文字/边框用等级色，无底色填充
// 已核对 VRCX-Luo UserSummaryHeader Badge(variant=outline) + x-tag-{rank} 颜色注入
import { computed } from 'vue';
import { trustColor, trustName } from '../utils.js';

const props = defineProps({
  level: { type: String, default: '' },   // tag 原文或旧推断值均可
});
const name = computed(() => trustName(props.level));
const color = computed(() => trustColor(props.level));
</script>

<template>
  <span v-if="name" class="trust-badge" :style="{ color, borderColor: color }">
    <i class="pi pi-shield"></i>{{ name }}
  </span>
</template>

<style scoped>
.trust-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid;
  border-radius: 999px;
  padding: 0 8px;
  line-height: 18px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.trust-badge .pi { font-size: 10px; }
</style>
