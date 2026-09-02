
const token=new URLSearchParams(location.search).get('token')||sessionStorage.getItem('vrc_dashboard_token')||'';if(token)sessionStorage.setItem('vrc_dashboard_token',token);const api=p=>token?`${p}${p.includes('?')?'&':'?'}token=${encodeURIComponent(token)}`:p;const labels={'friend-online':'上线','friend-offline':'下线','friend-location':'位置变动','friend-update':'资料变动','friend-active':'状态变动','friend-add':'加好友','friend-delete':'删好友','user-location':'我的位置','user-update':'资料变动','notification':'通知','notification-v2':'通知'};let state={view:'feed',filter:'all',friends:[],events:[],feedEvents:[],feedHasMore:false,selected:null,nicknameMap:{}};window.__state=state;
window.__renderView=(view)=>{if(!_vmap[view])return;state.view=view;if(window.__store)window.__store.view=view;syncViewNav(view);document.querySelector('#viewTitle').textContent=_vmap[view];document.title='VRChat Assistant · '+_vmap[view];syncHash();render()};
function copyText(t){if(!t)return;if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).catch(()=>{})}else{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch{}ta.remove()}toast('已复制 '+String(t).slice(0,28))}
// 同形字伪装检测（对齐 VRCX confusables.js）：希腊/西里尔/全角等与拉丁字母视觉相似的字符
const CONFUSABLES={'Α':'A','Β':'B','Ε':'E','Ζ':'Z','Η':'H','Ι':'I','Κ':'K','Μ':'M','Ν':'N','Ο':'O','Ρ':'P','Τ':'T','Χ':'X','α':'a','β':'b','γ':'y','δ':'d','ε':'e','ζ':'z','η':'n','θ':'o','ι':'i','κ':'k','λ':'l','μ':'u','ν':'v','ξ':'x','ο':'o','π':'n','ρ':'p','σ':'o','τ':'t','υ':'u','φ':'f','χ':'x','ψ':'y','А':'A','В':'B','Е':'E','З':'3','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','У':'Y','Х':'X','а':'a','в':'b','е':'e','з':'3','к':'k','м':'m','н':'h','о':'o','р':'p','с':'c','т':'t','у':'y','х':'x','і':'i','０':'0','１':'1','２':'2','３':'3','４':'4','５':'5','６':'6','７':'7','８':'8','９':'9','ａ':'a','ｂ':'b','ｃ':'c','ｄ':'d','ｅ':'e','ｆ':'f','ｇ':'g','ｈ':'h','ｉ':'i','ｊ':'j','ｋ':'k','ｌ':'l','ｍ':'m','ｎ':'n','ｏ':'o','ｐ':'p','ｑ':'q','ｒ':'r','ｓ':'s','ｔ':'t','ｕ':'u','ｖ':'v','ｗ':'w','ｘ':'x','ｙ':'y','ｚ':'z','Ａ':'A','Ｂ':'B','Ｃ':'C','Ｄ':'D','Ｅ':'E','Ｆ':'F','Ｇ':'G','Ｈ':'H','Ｉ':'I','Ｊ':'J','Ｋ':'K','Ｌ':'L','Ｍ':'M','Ｎ':'N','Ｏ':'O','Ｐ':'P','Ｑ':'Q','Ｒ':'R','Ｓ':'S','Ｔ':'T','Ｕ':'U','Ｖ':'V','Ｗ':'W','Ｘ':'X','Ｙ':'Y','Ｚ':'Z','。':'.','，':',','．':'.','：':':','；':';','！':'!','？':'?','（':'(','）':')'};
function confusableFlag(name){if(!name)return '';const s=String(name);const hits=[...new Set([...s].filter(ch=>CONFUSABLES[ch]).map(ch=>CONFUSABLES[ch]))];if(!hits.length)return '';return `<span class="confusable" title="该名称包含与拉丁字母/常见符号视觉相似的字符（疑似 ${esc(hits.slice(0,4).join(', '))}），可能是伪装账号">⚠ 疑似混淆名</span>`}
function flagName(name){return esc(name)+confusableFlag(name)}
function toast(msg){let el=document.querySelector('#toast');if(!el){el=document.createElement('div');el.id='toast';el.setAttribute('aria-live','polite');el.setAttribute('role','status');document.body.appendChild(el)}el.textContent=msg;el.classList.add('show');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),1600)}
function openPreview(url){if(!url)return;const o=document.querySelector('#previewOverlay');o.querySelector('#previewImg').src=url;o.classList.add('show')}
function closePreview(){document.querySelector('#previewOverlay').classList.remove('show')}
function bindCopyAndPreview(root){root.querySelectorAll('[data-copy]').forEach(el=>el.onclick=(e)=>{e.stopPropagation();copyText(el.dataset.copy)});root.querySelectorAll('[data-preview]').forEach(el=>el.onclick=(e)=>{e.stopPropagation();openPreview(el.dataset.preview)})}
function nameFor(x){const nk=state.nicknameMap&&state.nicknameMap[x?.userId];if(nk)return nk;if(x?.displayName&&!/^usr_[a-z0-9-]+$/i.test(x.displayName))return x.displayName;const friend=state.friends.find(f=>f.userId===x?.userId);return friend?.displayName||x?.displayName||x?.userId||'未知用户'}





let _nickname='';
async function loadNickname(userId){try{const d=await get('/api/dashboard/nickname?userId='+encodeURIComponent(userId));const arr=d.nicknames||[];const hit=arr.find(n=>(n.user_id||n.userId)===userId);_nickname=hit?(hit.nickname||''):'';}catch{_nickname=''}const el=document.querySelector('#nicknameRow');if(!el||!state.selected)return;const disp=state.selected.displayName||state.selected.userId;el.innerHTML=`<span>本地备注</span><b>${esc(_nickname||'（无）')}</b><button id="nicknameSet">${_nickname?'修改':'设置'}</button>`;const b=document.querySelector('#nicknameSet');if(b)b.onclick=async()=>{const v=prompt('输入本地备注（留空清除）',_nickname);if(v===null)return;try{await fetch(api('/api/dashboard/nickname'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,displayName:disp,nickname:(v||'').trim()})});_nickname=(v||'').trim();loadNickname(userId)}catch{alert('备注设置失败')}}}
const _viewGetCache = {};
const _VIEW_GET_TTL = 60_000;
const _CACHED_VIEWS = ['/api/dashboard/home','/api/dashboard/favorites','/api/dashboard/avatars','/api/dashboard/moderation','/api/dashboard/recent-worlds','/api/dashboard/stats'];
async function rawGet(p){const r=await fetch(api(p));if(!r.ok)throw Error(r.status);return r.json()}
async function refreshViewGet(p){try{const d=await rawGet(p);_viewGetCache[p]={at:Date.now(),data:d}}catch{}}
function invalidateViewCache(prefix){for(const k of Object.keys(_viewGetCache)){if(k.startsWith(prefix))delete _viewGetCache[k]}}
async function get(p){
  const useCache=_CACHED_VIEWS.some(x=>p.startsWith(x));
  if(!useCache)return rawGet(p);
  const now=Date.now();const c=_viewGetCache[p];
  if(c&&now-c.at<_VIEW_GET_TTL)return c.data;
  if(c){refreshViewGet(p);return c.data}
  const d=await rawGet(p);_viewGetCache[p]={at:now,data:d};return d;
}






































let viewToken=0;
function render(){const token=++viewToken;const mc=document.querySelector('#mainContent');const vm=document.querySelector('#vueMain');const fl=document.querySelector('#filters');const isVueView=['feed','friends','charts','search','favorites','worlds','players','logs','avatars','moderation','tools','open'].includes(state.view);if(mc)mc.style.display=isVueView?'none':'';if(vm)vm.style.display=isVueView?'':'none';if(fl)fl.style.display=isVueView?'none':'';if(state.view==='feed'){if(window.__feedView&&typeof window.__feedView.load==='function')window.__feedView.load();return}if(state.view==='friends'){if(window.__friendsView&&typeof window.__friendsView.load==='function')window.__friendsView.load();return}if(state.view==='charts'){if(window.__chartsView&&typeof window.__chartsView.load==='function')window.__chartsView.load();return}if(isVueView)return;if(state.view==='moderation'){loadModeration(token);return}if(state.view==='avatars'){loadAvatars(token);return}if(state.view==='charts'){loadStats(token);return}if(state.view==='search'){loadSearch(token);return}if(state.view==='favorites'){loadFavorites(token);return}if(state.view==='worlds'){loadWorlds(token);return}if(state.view==='players'){loadPlayers(token);return}if(state.view==='logs'){loadLogs(token);return}if(state.view==='tools'){loadTools(token);return}const feedList=state.feedEvents&&state.feedEvents.length?state.feedEvents:state.events;const rows=state.filter==='all'?feedList:state.filter==='fav'?feedList.filter(x=>state.favFriendIds&&state.favFriendIds.has(x.userId)):state.filter==='friend-update-avatar'?feedList.filter(x=>x.type==='friend-update'&&x.updateType==='avatar'):state.filter==='friend-update-bio'?feedList.filter(x=>x.type==='friend-update'&&x.updateType==='bio'):feedList.filter(x=>x.type===state.filter);let html;if(state.view==='feed')html=`<div class="tablehead"><span>时间</span><span>类型</span><span>玩家</span><span>详细信息</span><span>世界</span></div>`+(rows.length?rows.map(eventRow).join(''):'<div class="empty">暂无好友动态</div>')+(state.feedHasMore?`<button class="load-more" data-load-more>加载更多 · 已显示 ${state.feedEvents.length} 条</button>`:'');else if(state.view==='friends'){const _on=state.friends.filter(x=>x.isOnline);const _off=state.friends.filter(x=>!x.isOnline);const _web=_on.filter(x=>isWebOnline(x));const _ing=_on.filter(x=>!isWebOnline(x));const _bm=new Map();for(const f of _ing){const k=f.worldId||'none';if(!_bm.has(k))_bm.set(k,[]);_bm.get(k).push(f)}const _gs=[..._bm.entries()].map(([wid,list])=>({label:(list[0].worldName&&list[0].worldName!==wid)?list[0].worldName:(wid==='none'?'未指定位置':wid.slice(0,12)),list}));html=state.friends.length?(`<div class="fl-head"><span>玩家</span><span>状态</span><span>位置</span><span>实例</span></div>`+_gs.map(g=>`<div class="worldgroup"><span class="wg-label">${esc(g.label)} · ${g.list.length}</span>${g.list.map(friendRow).join('')}</div>`).join('')+(_web.length?`<div class="worldgroup"><span class="wg-label">仅网页在线 · ${_web.length}</span>${_web.map(friendRow).join('')}</div>`:'')+(_off.length?`<div class="worldgroup"><span class="wg-label">离线 · ${_off.length}</span>${_off.map(friendRow).join('')}</div>`:'')):'<div class="empty">暂无好友</div>'}else html='<div class="empty">该模块即将接入</div>';document.querySelector('#mainContent').innerHTML=html;bindCopyAndPreview(document.querySelector('#mainContent'));document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===state.filter));document.querySelectorAll('[data-user]').forEach(el=>el.onclick=()=>{if(el.dataset.user&&el.dataset.user.startsWith('not_'))return;const x=state.friends.find(f=>f.userId===el.dataset.user)||state.events.find(e=>e.userId===el.dataset.user);if(x)openUser(x)});document.querySelectorAll('[data-event]').forEach(el=>el.onclick=e=>{if(e.target.closest('[data-world]')){const wid=e.target.closest('[data-world]').dataset.world;if(wid&&wid.startsWith('wrld_'))openWorld(wid)}else if(e.target.closest('.player')){const uid=el.dataset.user;if(!uid||uid.startsWith('not_'))return;const x=state.friends.find(f=>f.userId===uid)||state.events.find(v=>v.userId===uid);if(x)openUser(x)}else{state.expanded=state.expanded===Number(el.dataset.event)?null:Number(el.dataset.event);render()}})}document.querySelectorAll('[data-load-more]').forEach(b=>b.onclick=()=>loadMoreFeed());document.querySelectorAll('#mainContent [data-event],#mainContent [data-user]').forEach(el=>{el.setAttribute('role','button');el.setAttribute('tabindex','0');el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click()}})})





function syncViewNav(view){document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===view))}
async function load(){try{const[o,f,e,fv,nk]=await Promise.all([get('/api/dashboard/overview'),get('/api/dashboard/friends?limit=1000'),get('/api/dashboard/events?limit=50'),get('/api/dashboard/favorites?type=friends'),get('/api/dashboard/nicknames-all')]);state.favFriendIds=new Set(((fv&&fv.favorites)||[]).map(x=>x.userId));state.nicknameMap={};for(const n of ((nk&&nk.nicknames)||[]))state.nicknameMap[n.user_id||n.userId]=n.nickname||n.displayName||'';state.friends=f.friends||[];if(state.feedEvents.length<=50)state.feedEvents=e.events||[];state.feedHasMore=state.feedEvents.length>=50;state.events=state.feedEvents;document.querySelector('#auth').textContent='AUTH '+(o.auth?.authenticated?'OK':'ACTION');document.querySelector('#ws').textContent='WS '+(o.ws?.status||'—');document.querySelector('#db').textContent='DB '+(o.db?.events||0);render()}catch{document.querySelector('#mainContent').innerHTML='<div class="error">Dashboard 请求失败，请确认 Token 后刷新。</div>'}}
async function loadMoreFeed(){if(state.loadingMore||!state.feedHasMore)return;state.loadingMore=true;try{const d=await get('/api/dashboard/events?limit=50&offset='+state.feedEvents.length);const more=d.events||[];if(!more.length){state.feedHasMore=false}else{state.feedEvents=[...state.feedEvents,...more];state.events=state.feedEvents;state.feedHasMore=more.length>=50}render()}catch{alert('加载更多失败')}finally{state.loadingMore=false}}
let sseRefreshAt=0;
function renderSse(){const el=document.querySelector('#sse');if(el)el.textContent=state.sse==='live'?'SSE LIVE':state.sse==='reconnect'?'SSE 重连中…':'SSE —';const c=document.querySelector('#connection');if(c&&state.sse==='live')c.textContent='已连接 · 实时'}
function onSseEvent(dto){const now=Date.now();if(state.view==='feed'){if(now-sseRefreshAt>1000){sseRefreshAt=now;refreshFeedEvents()}}else if(now-sseRefreshAt>5000){sseRefreshAt=now;load()}renderSse()}
async function refreshFeedEvents(){try{const d=await get('/api/dashboard/events?limit=50');if(d.events){state.feedEvents=d.events;state.feedHasMore=d.events.length>=50;state.events=state.feedEvents;if(state.view==='feed')render()}}catch{}}
function startSse(){if(state.es)return;const es=new EventSource(api('/api/dashboard/stream'));state.es=es;es.onopen=()=>{state.sse='live';renderSse()};es.onmessage=(m)=>{let d;try{d=JSON.parse(m.data)}catch{return}if(d.type==='event'&&d.event)onSseEvent(d.event)};es.onerror=()=>{state.sse='reconnect';renderSse()}}
function syncHash(){const q=new URLSearchParams();q.set('view',state.view);if(state.filter&&state.filter!=='all')q.set('filter',state.filter);history.replaceState(null,'',location.pathname+location.search+'#'+q.toString())}const _vmap={feed:'好友动态',friends:'好友位置',worlds:'世界记录',charts:'活动图表',tools:'工具',search:'搜索',favorites:'收藏',moderation:'屏蔽管理',avatars:'我的模型'};{const _hp=new URLSearchParams(location.hash.replace(/^#/,''));if(_hp.get('view')&&_vmap[_hp.get('view')])state.view=_hp.get('view');if(_hp.get('filter')&&state.filter==='all')state.filter=_hp.get('filter');if(_hp.get('filter')&&_hp.get('filter')!=='all')state.filter=_hp.get('filter');syncViewNav(state.view);document.querySelector('#viewTitle').textContent=_vmap[state.view]||'好友动态';document.title='VRChat Assistant · '+(_vmap[state.view]||'好友动态')}document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;syncHash();render()});document.querySelectorAll('[data-profile-tab]').forEach(b=>b.onclick=()=>profileTab(b.dataset.profileTab));document.querySelector('#refresh').onclick=load;document.querySelector('#modalClose').onclick=closeModal;document.querySelector('#modalBack').onclick=closeModal;document.querySelector('#worldModalClose').onclick=closeWorldModal;document.querySelector('#worldModalBack').onclick=closeWorldModal;document.querySelector('#avatarModalClose').onclick=closeAvatarModal;document.querySelector('#avatarModalBack').onclick=closeAvatarModal;document.querySelector('#previewOverlay').onclick=closePreview;document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();closeWorldModal();closeAvatarModal();closePreview();if(window.__store)window.__store.selected=null}});async function applyStatus(status,desc){try{const r=await fetch(api('/api/dashboard/status'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,statusDescription:desc||''})});const d=await r.json();toast(d.ok?'状态已更新'+(desc?('：'+desc):''):(d.error||'更新失败'))}catch{toast('更新失败')}}
async function loadVrcStatus(){try{const r=await fetch(api('/api/dashboard/vrc-status'),{signal:AbortSignal.timeout(16000)});const d=await r.json();const el=document.querySelector('#vrcs');if(!el)return;if(d.status&&d.status.indicator){const ok=d.status.indicator!=='major'&&d.status.indicator!=='critical';el.textContent='VRC '+(ok?'● ':'⚠ ')+d.status.description;el.className=ok?'':'warn'}else{el.textContent='VRC —'}}catch{const el=document.querySelector('#vrcs');if(el){el.textContent='VRC —'}}}
loadVrcStatus();setInterval(loadVrcStatus,60000);
