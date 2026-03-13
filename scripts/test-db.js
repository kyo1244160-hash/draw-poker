/**
 * scripts/test-db.js — DB接続テスト
 *
 * 実行方法:
 *   node scripts/test-db.js
 */

require('dotenv').config({ path: '.env.local' });
const postgres = require('postgres');

async function main() {
  console.log('--- DB接続テスト ---');

  // 1. DATABASE_URL の確認
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL が .env.local に設定されていません');
    process.exit(1);
  }
  console.log('✅ DATABASE_URL を検出しました');

  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    ssl: 'require',
  });

  try {
    // 2. 接続確認
    const [{ now }] = await sql`SELECT NOW() as now`;
    console.log(`✅ DB接続成功: ${now}`);

    // 3. テーブル存在確認
    const tables = await sql`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `;
    const names = tables.map(t => t.tablename);
    console.log(`✅ テーブル一覧: ${names.join(', ')}`);

    const required = [
      'accounts', 'profiles', 'admins',
      'blind_schedules', 'tournaments', 'tournament_seats',
      'tournament_results', 'tournament_chip_log',
      'points', 'point_history',
    ];
    const missing = required.filter(t => !names.includes(t));
    if (missing.length > 0) {
      console.error(`❌ 不足テーブル: ${missing.join(', ')}`);
      console.error('   → Supabase の SQL Editor で schema.sql を実行してください');
    } else {
      console.log('✅ 全テーブル確認済み');
    }

    // 4. ブラインドスケジュール確認
    const schedules = await sql`SELECT id, name FROM blind_schedules`;
    if (schedules.length === 0) {
      console.warn('⚠️  blind_schedules にデータがありません（schema.sql の末尾のINSERTが実行されていない可能性）');
    } else {
      console.log(`✅ ブラインドスケジュール: ${schedules.map(s => s.id).join(', ')}`);
    }

    console.log('\n🎉 すべての確認が完了しました。Step 3 に進めます。');
  } catch (err) {
    console.error('❌ エラー:', err.message);
    if (err.message.includes('password')) {
      console.error('   → DATABASE_URL のパスワード部分を確認してください');
    } else if (err.message.includes('ECONNREFUSED') || err.message.includes('timeout')) {
      console.error('   → Session pooler の接続文字列を使っているか確認してください');
    }
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
