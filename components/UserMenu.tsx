/**
 * components/UserMenu.tsx — ログイン状態表示・ログインボタン
 */

import { useSession, signIn, signOut } from 'next-auth/react';

interface Props {
  onNicknameNeeded?: () => void;
}

export default function UserMenu({ onNicknameNeeded }: Props) {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return <div style={S.wrap}><span style={S.loading}>...</span></div>;
  }

  // 未ログイン
  if (!session) {
    return (
      <div style={S.wrap}>
        <button style={S.loginBtn} onClick={() => signIn('google', { callbackUrl: '/' })}>
          <GoogleIcon />
          <span>Google でログイン</span>
        </button>
      </div>
    );
  }

  // ニックネーム未設定
  if (!session.user.nickname) {
    return (
      <div style={S.wrap}>
        <button style={S.setupBtn} onClick={onNicknameNeeded}>
          ⚠ ニックネームを設定してください
        </button>
      </div>
    );
  }

  // ログイン済み
  return (
    <div style={S.wrap}>
      <span style={S.nickname}>♠ {session.user.nickname}</span>
      <button style={S.logoutBtn} onClick={() => signOut()}>
        ログアウト
      </button>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 14.013 17.64 11.705 17.64 9.2z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
      <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
    </svg>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    display:    'flex',
    alignItems: 'center',
    gap:        '10px',
  },
  loading: {
    color:      'var(--gold-dim)',
    fontSize:   '13px',
    fontFamily: 'var(--font-title)',
    letterSpacing: '0.1em',
  },
  loginBtn: {
    display:        'flex',
    alignItems:     'center',
    gap:            '10px',
    background:     'linear-gradient(135deg, rgba(201,168,76,0.15), rgba(201,168,76,0.05))',
    color:          'var(--gold)',
    border:         '1px solid var(--gold-dim)',
    borderRadius:   '6px',
    padding:        '9px 18px',
    fontSize:       '13px',
    cursor:         'pointer',
    fontFamily:     'var(--font-title)',
    letterSpacing:  '0.08em',
    boxShadow:      '0 2px 10px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.07)',
    whiteSpace:     'nowrap' as const,
    transition:     'all 0.2s',
  },
  setupBtn: {
    background:     'transparent',
    color:          '#e8a020',
    border:         '1px solid #a06010',
    borderRadius:   '6px',
    padding:        '7px 14px',
    fontSize:       '12px',
    cursor:         'pointer',
    fontFamily:     'var(--font-title)',
    letterSpacing:  '0.06em',
    whiteSpace:     'nowrap' as const,
  },
  nickname: {
    color:          'var(--gold)',
    fontSize:       '14px',
    fontFamily:     'var(--font-title)',
    letterSpacing:  '0.1em',
    textShadow:     '0 0 10px rgba(201,168,76,0.4)',
  },
  logoutBtn: {
    background:     'transparent',
    color:          'var(--cream-dim)',
    border:         '1px solid rgba(255,255,255,0.12)',
    borderRadius:   '5px',
    padding:        '5px 11px',
    fontSize:       '11px',
    cursor:         'pointer',
    fontFamily:     'var(--font-title)',
    letterSpacing:  '0.06em',
  },
};
