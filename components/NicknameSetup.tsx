/**
 * components/NicknameSetup.tsx — ニックネーム設定モーダル
 *
 * - 初回ログイン時に強制表示（スキップ不可）
 * - 設定完了後に onComplete() を呼び出してモーダルを閉じる
 */

import { useState } from 'react';
import { useSession } from 'next-auth/react';

interface Props {
  onComplete: (nickname: string) => void;
}

export default function NicknameSetup({ onComplete }: Props) {
  const { update } = useSession();
  const [nickname, setNickname] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  const handleSubmit = async () => {
    const trimmed = nickname.trim();
    if (!trimmed) { setError('ニックネームを入力してください'); return; }

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/profile/nickname', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ nickname: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? '設定に失敗しました');
        return;
      }

      // NextAuth セッションを更新して nickname を反映
      await update();
      onComplete(data.nickname);
    } catch {
      setError('通信エラーが発生しました');
    } finally {
      setLoading(false);
    }
  };

  return (
    // オーバーレイ（クリックしても閉じない）
    <div style={S.overlay}>
      <div style={S.modal}>
        <h2 style={S.title}>ニックネームを設定</h2>
        <p style={S.desc}>
          ゲーム内で表示される名前を設定してください。<br />
          <span style={S.note}>2〜12文字 / 日本語・英数字・_ - . が使用できます</span>
        </p>

        <input
          style={S.input}
          type="text"
          value={nickname}
          maxLength={12}
          placeholder="例: Pastis太郎"
          onChange={(e) => { setNickname(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && !loading && handleSubmit()}
          autoFocus
        />

        {error && <p style={S.error}>{error}</p>}

        <button
          style={{ ...S.btn, opacity: loading ? 0.6 : 1 }}
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? '設定中...' : '設定する →'}
        </button>

        <p style={S.caution}>
          ※ 設定後の変更は30日に1回までです
        </p>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position:        'fixed',
    inset:           0,
    background:      'rgba(0,0,0,0.75)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          1000,
  },
  modal: {
    background:   '#1a3a2a',
    border:       '1px solid #3a6a4a',
    borderRadius: '12px',
    padding:      '36px 32px',
    width:        'min(420px, 90vw)',
    display:      'flex',
    flexDirection:'column',
    gap:          '16px',
  },
  title: {
    color:      '#e8d5a3',
    fontSize:   '22px',
    fontWeight: 700,
    margin:     0,
    textAlign:  'center',
    fontFamily: 'var(--font-title, serif)',
  },
  desc: {
    color:      '#ccc',
    fontSize:   '14px',
    lineHeight: 1.6,
    margin:     0,
    textAlign:  'center',
  },
  note: {
    color:    '#aaa',
    fontSize: '12px',
  },
  input: {
    background:   '#0d2a1a',
    border:       '1px solid #3a6a4a',
    borderRadius: '6px',
    color:        '#fff',
    fontSize:     '18px',
    padding:      '10px 14px',
    outline:      'none',
    width:        '100%',
    boxSizing:    'border-box',
  },
  error: {
    color:    '#ff6b6b',
    fontSize: '13px',
    margin:   0,
  },
  btn: {
    background:   '#2a6a3a',
    color:        '#e8d5a3',
    border:       '1px solid #4a9a5a',
    borderRadius: '6px',
    padding:      '12px',
    fontSize:     '16px',
    fontWeight:   700,
    cursor:       'pointer',
    width:        '100%',
  },
  caution: {
    color:     '#888',
    fontSize:  '12px',
    margin:    0,
    textAlign: 'center',
  },
};
