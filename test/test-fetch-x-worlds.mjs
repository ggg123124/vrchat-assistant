// 测试 fetch-x-worlds.js 的新函数（extractWorldsFromTweetText + 降级 + t.co 短链解包）
import {
  extractWorldsFromTweetText, fetchCreatorTweets, fetchCreatorViaSearchTimeline,
  extractTcoLinks, resolveTcoLink, resolveTcoWorldIds, enrichWorldIdsFromTco,
} from '../core/fetch-x-worlds.js';

let pass = 0, fail = 0;
function assert(label, cond) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

console.log('=== 1. extractWorldsFromTweetText 单元测试 ===');

// Bradlee1011 格式：World name: XX\nBy: YY\nPlatform: Z
let r = extractWorldsFromTweetText('World name: Tranquility Lane （Fallout 3）\nBy: ControVR\nPlatform: PC & Quest');
assert('Bradlee 格式世界名', r.worldNames.includes('Tranquility Lane （Fallout 3）'));
assert('Bradlee 格式作者', r.authorName === 'ControVR');

// fox_yata9 格式：World:XXX By:YYY
r = extractWorldsFromTweetText('World:OPERATION MIST RUNNER -Air to Ground PvE- Ver1.1\nBy:しゅまるしゅ');
assert('fox 格式世界名', r.worldNames.some(n => n.includes('MIST RUNNER')));
assert('fox 格式作者', r.authorName.includes('しゅまるしゅ'));

// wrld_ 链接提取
r = extractWorldsFromTweetText('ワールドリンク https://vrchat.com/home/world/wrld_f1422a06-bf4a-47e4-94bf-d925a0e4a86f');
assert('wrld 链接提取', r.worldIds.includes('wrld_f1422a06-bf4a-47e4-94bf-d925a0e4a86f'));

// launch?worldId 格式
r = extractWorldsFromTweetText('Android対応 https://vrchat.com/home/launch?worldId=wrld_b1992535-7aca-4cbb-8448-05c832c86ea6');
assert('launch worldId 提取', r.worldIds.includes('wrld_b1992535-7aca-4cbb-8448-05c832c86ea6'));

// 特殊字符世界名（Freedom. 的 Unicode 点）
r = extractWorldsFromTweetText('World name: Freedom.\nBy: Ina Crow\nPlatform: PC');
assert('特殊字符世界名 Freedom.', r.worldNames.some(n => n.includes('Freedom')));

console.log('\n=== 2. t.co 短链解包函数单元测试（纯本地） ===');

// extractTcoLinks：提取全部 t.co 短链（去重）
const tcoText = '世界推荐 https://t.co/abc123XYZ 好美，还有 https://t.co/abc123XYZ 与 https://t.co/def456UVW';
const tcoLinks = extractTcoLinks(tcoText);
assert('extractTcoLinks 提取 2 个去重短链', tcoLinks.length === 2);
assert('extractTcoLinks 内容正确', tcoLinks.includes('https://t.co/abc123XYZ') && tcoLinks.includes('https://t.co/def456UVW'));

// 空文本 / 无短链
assert('extractTcoLinks 空文本返回空数组', extractTcoLinks('').length === 0);
assert('extractTcoLinks 无短链返回空数组', extractTcoLinks('只是一个普通文本，没有链接').length === 0);

// enrichWorldIdsFromTco：无 t.co 链接时原样返回（不产生副作用）
const plainTweet = { id: 't0', text: 'World:Something\nBy:Somebody', worldIds: ['wrld_00000000-0000-4000-8000-000000000000'], worldNames: ['Something'] };
const plainResult = await enrichWorldIdsFromTco(plainTweet);
assert('enrichWorldIdsFromTco 无短链不改 worldIds', plainResult.worldIds.length === 1);

console.log(`\n=== 3. t.co 解包网络测试（需 --network 参数，t.co 返回 200 HTML + meta refresh）===`);
if (process.argv.includes('--network')) {
  try {
    const real = await resolveTcoLink('https://t.co/PG75RyfR9R');
    assert('resolveTcoLink 解出 vrchat 链接', real && real.includes('vrchat.com/home/world/'));
    const ids = await resolveTcoWorldIds(['https://t.co/PG75RyfR9R']);
    assert('resolveTcoWorldIds 解出 wrld_ ID', ids.length > 0 && /^wrld_[0-9a-f-]{36}$/.test(ids[0]));
  } catch (e) {
    console.log(`  ✗ t.co 解包网络测试失败: ${e.message.slice(0, 100)}`);
    fail++;
  }
} else {
  console.log('  （跳过：无 --network 参数。t.co 解包依赖网络，不稳定）');
}

console.log(`\n=== 4. 降级流程测试（需 --network 参数，依赖网络）===`);
if (process.argv.includes('--network')) {
  try {
    const { tweets, source } = await fetchCreatorTweets('Bradlee1011');
    console.log(`  ✓ fetchCreatorTweets: 来源=${source}, ${tweets.length} 条推文`);
    const worldTweets = tweets.filter(t => t.worldNames.length > 0 || t.worldIds.length > 0);
    console.log(`    含世界推荐: ${worldTweets.length} 条`);
  } catch (e) {
    console.log(`  ✗ fetchCreatorTweets 双源失败: ${e.message.slice(0, 100)}`);
    fail++;
  }
} else {
  console.log('  （跳过：无 --network 参数。X/Nitter 均可能被限流，网络测试不稳定）');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);