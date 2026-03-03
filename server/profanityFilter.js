/**
 * profanityFilter.js — 公序良俗フィルター
 *
 * 部屋名・プレイヤー名に不適切な文字列が含まれていないかチェックします。
 * 完全な網羅は困難なため、明らかに問題のある語句のみ拒否します。
 */

/** 禁止ワードリスト（正規表現でマッチ）*/
const BANNED_PATTERNS = [
  // 性的表現
  /sex|porn|fuck|shit|dick|pussy|cock|ass(?:hole)?|bitch|hentai|えろ|エロ|せっくす|ちんこ|まんこ|おちんちん/i,
  // 差別・ヘイト
  /nigger|faggot|retard|chink/i,
  // 暴力・脅迫
  /kill|murder|rape|terrorist/i,
  // 日本語の罵倒語
  /くそ|ばか|アホ|死ね|殺す|障害|キチガイ|きちがい/i,
];

/**
 * 文字列が公序良俗に反するかチェックする
 * @param {string} text - チェックする文字列
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkText(text) {
  if (!text || typeof text !== 'string') return { ok: false, reason: '無効な入力です' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: '空白のみの名前は使用できません' };
  if (trimmed.length > 30) return { ok: false, reason: '30文字以内で入力してください' };

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: '公序良俗に反する名称は使用できません' };
    }
  }
  return { ok: true };
}

module.exports = { checkText };
