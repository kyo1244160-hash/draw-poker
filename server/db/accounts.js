/**
 * server/db/accounts.js — accounts / profiles テーブル操作
 *
 * ⚠️ クエリは必ずタグ付きテンプレートリテラルで書くこと。
 *    文字列結合は SQL インジェクションの原因になるため禁止。
 */

const sql = require('./client');

/**
 * Google ログイン時に accounts を upsert する。
 * 初回は INSERT、2回目以降は google_name を UPDATE。
 */
async function upsertAccount({ id, email, googleName }) {
  const [row] = await sql`
    INSERT INTO accounts (id, email, google_name)
    VALUES (${id}, ${email}, ${googleName ?? null})
    ON CONFLICT (id) DO UPDATE
      SET google_name = EXCLUDED.google_name
    RETURNING id, email
  `;
  return row;
}

/**
 * account_id に紐づく nickname を取得する。
 * プロフィール未設定の場合は null を返す。
 */
async function getNickname(accountId) {
  const [row] = await sql`
    SELECT nickname FROM profiles WHERE account_id = ${accountId}
  `;
  return row?.nickname ?? null;
}

/**
 * ニックネームが既に使われているか確認する。
 */
async function isNicknameTaken(nickname) {
  const [row] = await sql`
    SELECT 1 FROM profiles WHERE nickname = ${nickname} LIMIT 1
  `;
  return !!row;
}

/**
 * ニックネームを初回設定する（change_count はカウントしない）。
 */
async function setNicknameFirst(accountId, nickname) {
  await sql`
    INSERT INTO profiles (account_id, nickname, change_count)
    VALUES (${accountId}, ${nickname}, 0)
  `;
}

/**
 * ニックネームを変更する。
 * 30日以内の変更は拒否する（呼び出し元でチェック済み前提だが DB 側でも記録する）。
 */
async function updateNickname(accountId, nickname) {
  const [row] = await sql`
    UPDATE profiles
    SET
      nickname             = ${nickname},
      nickname_updated_at  = NOW(),
      change_count         = change_count + 1
    WHERE account_id = ${accountId}
    RETURNING nickname, change_count, nickname_updated_at
  `;
  return row;
}

/**
 * プロフィール情報を取得する（ニックネーム変更可否の判定に使用）。
 */
async function getProfile(accountId) {
  const [row] = await sql`
    SELECT account_id, nickname, nickname_updated_at, change_count
    FROM profiles
    WHERE account_id = ${accountId}
  `;
  return row ?? null;
}

module.exports = {
  upsertAccount,
  getNickname,
  isNicknameTaken,
  setNicknameFirst,
  updateNickname,
  getProfile,
};
