"""清理 x_world_recommendations 中的历史误报记录。
误报 = 名字包含匹配产生的错误世界（修复前旧扫描残留）。
保留同 tweet 的真实世界（如 WANDER、Nocturnal、孤独を讃えた終鈴、STILL ALONE）。
"""
import sqlite3, json

DB = 'vrc-monitor.sqlite3'

# (world_id, tweet_id) 需要移除的错误 creator 关联
# 或 (world_name 模糊, tweet_id) 移除指定 tweet 的关联
remove_specs = [
    # 孤 ← 孤独を讃えた終鈴 的单字子串误报
    ('wrld_29e92dbd-b1fa-479a-a53d-1f312cb54570', None),
    # MoonLit Wanderings ← WANDER 误报
    ('wrld_505f4d19-00a5-4', None),  # 前缀匹配
    # Nocturnal Loft v1.2.3 ← Nocturnal 误报
    ('wrld_87c262e8-82b4-4', None),
    # stil：只删 2086190511791165650 这条（保留 2086701538278555938 真实推荐）
    ('wrld_adff9fa7-f8fd-4', '2086190511791165650'),
    # Alone ← STILL ALONE 误报
    ('wrld_407e1579-d262-4', None),
]

conn = sqlite3.connect(DB)
cur = conn.cursor()

def remove_creator(row_id, tweet_id):
    """从记录的 creators JSON 中移除指定 tweet；空则删整行。"""
    cur.execute('SELECT world_id, world_name, creators FROM x_world_recommendations WHERE rowid=?', (row_id,))
    r = cur.fetchone()
    if not r:
        return
    wid, wname, creators_raw = r
    creators = json.loads(creators_raw)
    before = len(creators)
    remaining = [c for c in creators if c.get('tweet_id') != tweet_id]
    if len(remaining) != before:
        if remaining:
            cur.execute('UPDATE x_world_recommendations SET creators=? WHERE rowid=?',
                        (json.dumps(remaining, ensure_ascii=False), row_id))
            print(f'  更新 {wname}: 移除 tweet={tweet_id}，剩 {len(remaining)} 条推荐')
        else:
            cur.execute('DELETE FROM x_world_recommendations WHERE rowid=?', (row_id,))
            print(f'  删除 {wname}: 全部推荐均误报，整行移除')

for wid_prefix, tweet_id in remove_specs:
    cur.execute('SELECT rowid, world_id, world_name, creators FROM x_world_recommendations WHERE world_id LIKE ?', (wid_prefix + '%',))
    rows = cur.fetchall()
    for row in rows:
        rowid, wid, wname, creators_raw = row
        creators = json.loads(creators_raw)
        if tweet_id is None:
            # 删除整条（该世界只有误报来源）
            cur.execute('DELETE FROM x_world_recommendations WHERE rowid=?', (rowid,))
            print(f'删除 {wname}: 整行移除（{len(creators)} 条推荐均误报）')
        else:
            remove_creator(rowid, tweet_id)

conn.commit()

# 验证
print('\n=== 清理后检查 ===')
cur.execute('SELECT COUNT(*) FROM x_world_recommendations')
print(f'剩余世界: {cur.fetchone()[0]} 个')
for name in ['孤', 'MoonLit', 'Nocturnal', 'stil', 'Alone', 'STILL ALONE', 'WANDER', '孤独を讃えた']:
    cur.execute('SELECT world_name, favorites FROM x_world_recommendations WHERE world_name LIKE ?', (f'%{name}%',))
    for r in cur.fetchall():
        print(f'  {r[0]} | {r[1]}⭐')
conn.close()
