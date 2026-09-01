<script setup>
import { ref, onMounted, computed } from 'vue';
import { get, post } from '../api.js';
import { toast } from '../toast.js';
import { openAvatar } from '../store.js';

// 我的模型 + 收藏模型（对齐 VRCX Avatars）：/avatars?userId=me（更新排序）
// + /favorites?type=avatar；后端 30min 缓存 + stale-while-revalidate。
const tab = ref('my');
const q = ref('');
const myAvatars = ref([]);
const favAvatars = ref([]);
const loading = ref(false);

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const r = await get('/api/dashboard/avatars?limit=40');
    myAvatars.value = (r && r.avatars) || [];
    favAvatars.value = (r && r.favoriteAvatars) || [];
  } catch (e) {
    toast('加载模型失败：' + (e.message || e), 'error');
  } finally {
    loading.value = false;
  }
}

const filteredList = computed(() => {
  const list = tab.value === 'my' ? myAvatars.value : favAvatars.value;
  const query = q.value.trim().toLowerCase();
  if (!query) return list;
  return list.filter((a) => (a.name || '').toLowerCase().includes(query) || (a.avatarId || a.id || '').includes(query));
});

const idOf = (a) => a.avatarId || a.id || '';

const releaseLabel = (s) => (s === 'public' ? '公开' : s === 'private' ? '私有' : s || '');

// 收藏模型操作（收藏/取消收藏；走 /favorites avatar API）
function isFav(a) {
  const id = a.avatarId || a.id;
  return favAvatars.value.some((f) => (f.avatarId || f.id) === id);
}
async function toggleFav(a) {
  const id = a.avatarId || a.id;
  if (!id) return;
  const fav = isFav(a);
  try {
    const r = await post('/api/dashboard/avatar/favorite', { avatarId: id, favorite: !fav });
    if (r && r.error) throw new Error(r.error);
    if (fav) favAvatars.value = favAvatars.value.filter((f) => (f.avatarId || f.id) !== id);
    else favAvatars.value = [a, ...favAvatars.value];
    toast(fav ? '已取消收藏' : '已收藏', 'success');
  } catch (e) {
    toast('操作失败：' + (e.message || e), 'error');
  }
}

// 设为当前模型（selectAvatar；仅我的模型 tab 显示）
const selecting = ref('');
async function selectAvatar(a) {
  const id = a.avatarId || a.id;
  if (!id || selecting.value) return;
  selecting.value = id;
  try {
    const r = await post('/api/dashboard/avatar/select', { avatarId: id });
    if (r && r.error) throw new Error(r.error);
    toast('已切换当前模型：' + (a.name || id), 'success');
  } catch (e) {
    toast('切换失败：' + (e.message || e), 'error');
  } finally {
    selecting.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="av">
    <div class="av-head">
      <h2><i class="pi pi-user-edit"></i> 我的模型</h2>
      <span class="av-count">上传与收藏 · 后端 30 分钟缓存</span>
      <InputText v-model="q" placeholder="搜索模型…" class="av-search" aria-label="搜索模型" />
      <Button size="small" text icon="pi pi-refresh" title="刷新" @click="load" />
    </div>

    <div class="av-chips" role="group" aria-label="模型类别筛选">
      <button class="chip" :class="{ active: tab === 'my' }" @click="tab = 'my'">我的模型 ({{ myAvatars.length }})</button>
      <button class="chip" :class="{ active: tab === 'fav' }" @click="tab = 'fav'">收藏模型 ({{ favAvatars.length }})</button>
    </div>

    <div v-if="loading && !myAvatars.length" class="loading-mini"><ProgressSpinner style="width:28px;height:28px" strokeWidth="4" /></div>
    <div v-else-if="!filteredList.length" class="empty" style="padding:24px">{{ q ? '无匹配模型' : '暂无模型数据' }}</div>
    <div v-else class="av-grid">
      <button v-for="a in filteredList" :key="idOf(a)" class="av-card" @click="openAvatar(idOf(a))">
        <img v-if="a.imageUrl" class="av-cover" :src="a.imageUrl" :alt="a.name" loading="lazy" />
        <div v-else class="av-cover av-nocover"><i class="pi pi-user-edit"></i></div>
        <div class="ac-body">
          <b class="ac-name">{{ a.name || a.avatarId || a.id }}</b>
          <small class="ac-sub">
            <template v-if="a.authorName">作者 {{ a.authorName }} · </template>{{ releaseLabel(a.releaseStatus) }}
          </small>
        </div>
        <button v-if="tab === 'my'" type="button" class="ac-fav ac-select" :title="'设为当前模型'" :aria-label="'设为当前模型 ' + (a.name || '')" @click.stop="selectAvatar(a)">
          <i :class="selecting === (a.avatarId || a.id) ? 'pi pi-spin pi-spinner' : 'pi pi-check-circle'"></i>
        </button>
        <button type="button" class="ac-fav" :class="{ on: isFav(a) }" :title="isFav(a) ? '取消收藏' : '收藏'" :aria-label="(isFav(a) ? '取消收藏 ' : '收藏 ') + (a.name || '')" @click.stop="toggleFav(a)">
          <i :class="isFav(a) ? 'pi pi-star-fill' : 'pi pi-star'"></i>
        </button>
      </button>
    </div>
  </div>
</template>

<style scoped>
.av { padding: 4px; }
.av-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.av-count { font-size: 11px; color: var(--text-dim); flex: 1; min-width: 120px; }
.av-search { width: 180px; }
.av-chips { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }




.av-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.av-card { position: relative; border: 1px solid var(--border-soft); border-radius: 10px; overflow: hidden; background: var(--surface); cursor: pointer; padding: 0; text-align: left; color: inherit; font-family: inherit; transition: border-color 0.12s; }
.av-card:hover { border-color: var(--accent); }
.av-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.av-cover { width: 100%; aspect-ratio: 1/1; object-fit: cover; display: block; background: var(--surface-2); }
.av-nocover { display: flex; align-items: center; justify-content: center; color: var(--text-dim); font-size: 28px; }
.ac-fav { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.45); border: none; border-radius: 50%; width: 26px; height: 26px; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; transition: transform 0.12s; }
.ac-fav:hover { transform: scale(1.12); }
.ac-fav.on { color: #ffca28; }
.ac-select { color: #7bed9f; }
.ac-fav:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ac-body { padding: 7px 9px; }
.ac-name { font-size: 12px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-sub { font-size: 10px; color: var(--text-dim); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }


@media (max-width: 899px) {
  .av-search { width: 100%; order: 3; }
  .av-grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
  /* C1 触控目标：模型卡片收藏/选中按钮 26px→34px */
  .ac-fav { width: 34px; height: 34px; font-size: 15px; }
}
</style>
