/**
 * server/db/client.js — Supabase (PostgreSQL) 接続クライアント
 *
 * postgres パッケージを使用してタグ付きテンプレートリテラルでクエリを発行する。
 * SQL インジェクション対策のため、文字列結合でのクエリ組み立ては禁止。
 *
 * 使用例:
 *   const sql = require('./client');
 *   const rows = await sql`SELECT * FROM accounts WHERE id = ${id}`;
 */

const postgres = require('postgres');

if (!process.env.DATABASE_URL) {
  throw new Error('[db] DATABASE_URL が設定されていません。.env.local を確認してください。');
}

const sql = postgres(process.env.DATABASE_URL, {
  // Render の短命コネクションに対応するため接続プールを小さめに設定
  max: 5,
  // アイドル接続を 30 秒で切断（Supabase の接続数制限対策）
  idle_timeout: 30,
  // 接続確立のタイムアウト
  connect_timeout: 10,
  // SSL 必須（Supabase は常に SSL）
  ssl: 'require',
  // 本番以外ではクエリをコンソールに出力しない
  debug: false,
});

module.exports = sql;
