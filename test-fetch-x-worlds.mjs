// 测试 fetch-x-worlds.js 的新函数（extractWorldsFromTweetText + 降级）
import { extractWorldsFromTweetText, fetchCreatorTweets, fetchCreatorViaSearchTimeline } from './core/fetch-x-worlds.js';

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

console.log(`\n=== 2. 降级流程测试（需 --network 参数，依赖网络）===`);
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
