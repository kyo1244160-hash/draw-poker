/**
 * server/db/client.js — Supabase (PostgreSQL) 接続クライアント
 *
 * lazy init + 詳細ログ付き
 */

const postgres = require('postgres');

let _sql = null;
let _connectAttempted = false;

function getSql() {
  if (_sql) return _sql;

  if (!process.env.DATABASE_URL) {
    console.error('[db] ❌ DATABASE_URL が未設定です。.env.local を確認してください。');
    throw new Error('[db] DATABASE_URL が設定されていません。');
  }

  if (!_connectAttempted) {
    _connectAttempted = true;
    // パスワードを隠してURLを表示
    const masked = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':***@');
    console.log('[db] 接続先:', masked);
  }

  _sql = postgres(process.env.DATABASE_URL, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    ssl: 'require',
    debug: false,
    onnotice: (notice) => console.log('[db] notice:', notice.message),
  });

  return _sql;
}

// sql`...` 形式で使えるラッパー（エラーを詳細ログ付きでラップ）
module.exports = async function sql(strings, ...values) {
  try {
    return await getSql()(strings, ...values);
  } catch (err) {
    console.error('[db] ❌ クエリエラー:', err.message);
    console.error('[db]   code:', err.code);
    console.error('[db]   detail:', err.detail ?? '(なし)');
    throw err;
  }
};

module.exports.begin  = (...a) => getSql().begin(...a);
module.exports.end    = (...a) => getSql().end(...a);
module.exports.unsafe = (...a) => getSql().unsafe(...a);
module.exports.options = () => getSql().options;
