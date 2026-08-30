// 测试 Playwright 浏览器抓取后的 tweet 组装逻辑（纯函数，离线可过）
import { buildTweetFromBrowserItem, extractWorldsFromTweetText, extractWorldIdsFromLinks } from './core/fetch-x-worlds.js';

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

function testBuildTweetFromBrowserItem() {
  console.log('=== buildTweetFromBrowserItem 单元测试 ===');

  // 1. 标准 fox_yata9 格式：World:XX By:YY + world 链接 + status 链接
  const t1 = buildTweetFromBrowserItem({
    text: 'World:Desert Clash By:PatMaz02\nhttps://vrchat.com/home/world/wrld_12345678-1234-1234-1234-123456789abc',
    url: 'https://nitter.tiekoetter.com/fox_yata9/status/1234567890#m',
    time: '2026-08-24 12:34:56',
  });
  assert('标准格式 worldId 提取', t1.worldIds.includes('wrld_12345678-1234-1234-1234-123456789abc'));
  assert('标准格式 worldName 提取', t1.worldNames.includes('Desert Clash'));
  assert('标准格式作者提取', t1.authorName === 'PatMaz02');
  assert('标准格式 id 提取', t1.id === '1234567890');
  assert('标准格式 url 去掉 #m', t1.url === 'https://nitter.tiekoetter.com/fox_yata9/status/1234567890');
  assert('标准格式时间保留', t1.time === '2026-08-24 12:34:56');

  // 2. 没有 #m 的 status 链接
  const t2 = buildTweetFromBrowserItem({
    text: 'World:Tiny Space By:foo https://vrchat.com/home/world/wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    url: 'https://nitter.tiekoetter.com/fox_yata9/status/9876543210',
    time: '2026-08-23 08:00:00',
  });
  assert('无 #m 时 url 不变', t2.url === 'https://nitter.tiekoetter.com/fox_yata9/status/9876543210');
  assert('无 #m 时 id 提取', t2.id === '9876543210');

  // 3. 多条 world 链接去重 + launch worldId 格式
  const t3 = buildTweetFromBrowserItem({
    text: `A: https://vrchat.com/home/world/wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb
B: https://vrchat.com/home/launch?worldId=wrld_cccccccc-cccc-cccc-cccc-cccccccccccc`,
    url: 'https://nitter.tiekoetter.com/fox_yata9/status/1111111111#m',
    time: null,
  });
  assert('多条 worldId 提取', t3.worldIds.length === 2);
  assert('launch worldId 归一化', t3.worldIds.includes('wrld_cccccccc-cccc-cccc-cccc-cccccccccccc'));
  assert('时间为 null 时保留', t3.time === null);

  // 4. 空/无推荐推文
  const t4 = buildTweetFromBrowserItem({
    text: '今天天气不错，没有推荐。',
    url: 'https://nitter.tiekoetter.com/fox_yata9/status/2222222222#m',
    time: '2026-08-22 00:00:00',
  });
  assert('空推荐 worldIds 为空', t4.worldIds.length === 0);
  assert('空推荐 worldNames 为空', t4.worldNames.length === 0);
  assert('空推荐 id 仍可提取', t4.id === '2222222222');

  // 5. 无 status id 的非常规链接
  const t5 = buildTweetFromBrowserItem({
    text: 'World:Test By:Author https://vrchat.com/home/world/wrld_dddddddd-dddd-dddd-dddd-dddddddddddd',
    url: 'https://example.com/something',
    time: '2026-08-21 10:00:00',
  });
  assert('非常规链接 id 为空', t5.id === '');
  assert('非常规链接 url 原样保留', t5.url === 'https://example.com/something');

  // 6. 多行带作者 + Platform 边界
  const t6 = buildTweetFromBrowserItem({
    text: 'World name: Tranquility Lane （Fallout 3）\nBy: ControVR\nPlatform: PC & Quest',
    url: 'https://nitter.tiekoetter.com/Bradlee1011/status/3333333333#m',
    time: '2026-08-20 20:00:00',
  });
  assert('多行世界名', t6.worldNames.some(n => n.includes('Tranquility Lane')));
  assert('多行作者名', t6.authorName === 'ControVR');
  assert('多行 id', t6.id === '3333333333');

  // 7. 世界链接只存在于 <a href>（innerText 不含）——从 links 抽取并合并
  const t7 = buildTweetFromBrowserItem({
    text: 'World: Desert Linkage\nBy: SomeAuthor\nPlatform: PC',
    url: 'https://nitter.tiekoetter.com/fox_yata9/status/4444444444#m',
    time: '2026-08-19 09:00:00',
    links: ['https://vrchat.com/home/world/wrld_a1b2c3d4-e5f6-7890-abcd-ef1234567890/info', 'https://vrchat.com/home/group/grp_zzzz'],
  });
  assert('links 提取 worldId（带 /info 后缀）', t7.worldIds.includes('wrld_a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
  assert('grp_ 组链接被忽略', !t7.worldIds.some(x => x.startsWith('grp_')));
}

function testExtractWorldIdsFromLinks() {
  console.log('\n=== extractWorldIdsFromLinks 边界测试 ===');
  const ids = extractWorldIdsFromLinks([
    'https://vrchat.com/home/world/wrld_11111111-2222-3333-4444-555555555555/info',
    'https://vrchat.com/home/launch?worldId=wrld_66666666-7777-8888-9999-000000000000',
  ]);
  assert('world 链接提取', ids.includes('wrld_11111111-2222-3333-4444-555555555555'));
  assert('launch worldId 提取', ids.includes('wrld_66666666-7777-8888-9999-000000000000'));
  assert('grp/其它链接被过滤', extractWorldIdsFromLinks(['https://vrchat.com/home/group/grp_x']).length === 0);
}

function testExtractWorldsFromTweetText() {
  console.log('\n=== extractWorldsFromTweetText 边界测试 ===');

  // 非法/截断 worldId 应被过滤
  const r = extractWorldsFromTweetText('bad https://vrchat.com/home/world/wrld_6… truncated');
  assert('截断 worldId 被过滤', r.worldIds.length === 0);
}

testBuildTweetFromBrowserItem();
testExtractWorldsFromTweetText();
testExtractWorldIdsFromLinks();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
