/**
 * server/db/client.js — Supabase (PostgreSQL) 接続クライアント
 *
 * lazy init + 詳細ログ付き
 *
 * 開発環境（NODE_ENV=development）では Next.js HMR がモジュールを
 * 再評価するたびに新しい postgres クライアントが生成され、
 * Supabase Session pooler の同時接続上限（NANO: 15）に達する問題がある。
 * これを防ぐため、開発環境では global オブジェクトにインスタンスを保持して
 * HMR をまたいでシングルトンを維持する。
 */

const postgres = require('postgres');
const IS_DEV = process.env.NODE_ENV !== 'production';

// 開発環境: global でシングルトン維持（HMR をまたいで再利用）
// 本番環境: モジュールスコープの変数で管理
let _sql = IS_DEV ? (global._pgSqlInstance ?? null) : null;
let _connectAttempted = IS_DEV ? (global._pgConnectAttempted ?? false) : false;

function getSql() {
  if (_sql) return _sql;

  if (!process.env.DATABASE_URL) {
    console.error('[db] ❌ DATABASE_URL が未設定です。.env.local を確認してください。');
    throw new Error('[db] DATABASE_URL が設定されていません。');
  }

  if (!_connectAttempted) {
    _connectAttempted = true;
    if (IS_DEV) global._pgConnectAttempted = true;
    // パスワードを隠してURLを表示
    const masked = process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':***@');
    console.log('[db] 接続先:', masked);
  }

  // 開発環境: max=2（HMR による接続増加を抑制）、本番: max=5
  const maxConn = IS_DEV ? 2 : 5;

  _sql = postgres(process.env.DATABASE_URL, {
    max: maxConn,
    idle_timeout: 30,
    connect_timeout: 10,
    ssl: 'require',
    debug: false,
    onnotice: (notice) => console.log('[db] notice:', notice.message),
  });

  // 開発環境: global に保持して HMR をまたいで再利用
  if (IS_DEV) global._pgSqlInstance = _sql;

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
