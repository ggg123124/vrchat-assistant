
import Database from 'better-sqlite3';
const db = new Database('/app/data/vrc-monitor.sqlite3');
console.log('--- EVENT TYPES ---');
console.log(db.prepare('SELECT type, COUNT(*) as c FROM events GROUP BY type ORDER BY c DESC').all());
console.log('--- LATEST 10 EVENTS ---');
console.log(db.prepare('SELECT id, type, user_id, display_name, world_id, world_name, created_at FROM events ORDER BY id DESC LIMIT 10').all());
console.log('--- WORLD CACHE COUNT ---');
console.log(db.prepare('SELECT COUNT(*) as c FROM world_cache').get());
console.log('--- FRIENDS COUNT ---');
console.log(db.prepare('SELECT COUNT(*) as c FROM friends').get());
