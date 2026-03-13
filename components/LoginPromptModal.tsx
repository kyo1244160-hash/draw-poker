/**
 * components/LoginPromptModal.tsx — ログイン促進モーダル
 *
 * 未ログイン状態で入室しようとした際に表示する。
 */

import { signIn } from 'next-auth/react';

interface Props {
  onClose: () => void;
}

export default function LoginPromptModal({ onClose }: Props) {
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        {/* スーツ装飾 */}
        <div style={S.suits}>♠ ♥ ♦ ♣</div>

        <h2 style={S.title}>ログインが必要です</h2>
        <div style={S.divider} />

        <p style={S.desc}>
          テーブルに着くには<br />
          Google アカウントでのログインが必要です。
        </p>

        <button style={S.loginBtn} onClick={() => signIn('google')}>
          <GoogleIcon />
          Google でログイン
        </button>

        <button style={S.cancelBtn} onClick={onClose}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 14.013 17.64 11.705 17.64 9.2z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/>
      <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
    </svg>
  );
}

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position:       'fixed',
    inset:          0,
    background:     'rgba(0,0,0,0.78)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         1000,
    backdropFilter: 'blur(2px)',
  },
  modal: {
    background:    'linear-gradient(160deg, #1a4a2e, #0d2a1a)',
    border:        '1px solid var(--gold-dim)',
    borderRadius:  '14px',
    padding:       '40px 36px 32px',
    width:         'min(380px, 90vw)',
    display:       'flex',
    flexDirection: 'column' as const,
    alignItems:    'center',
    gap:           '16px',
    boxShadow:     '0 20px 60px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
  },
  suits: {
    fontFamily:    'var(--font-body)',
    fontSize:      '22px',
    color:         'var(--gold-dim)',
    letterSpacing: '12px',
  },
  title: {
    fontFamily:    'var(--font-title)',
    fontSize:      '22px',
    color:         'var(--gold-bright)',
    letterSpacing: '0.08em',
    margin:        0,
    textShadow:    '0 0 20px rgba(240,208,96,0.3)',
  },
  divider: {
    height:     '1px',
    width:      '80%',
    background: 'linear-gradient(90deg, transparent, var(--gold-dim), transparent)',
  },
  desc: {
    fontFamily:  'var(--font-body)',
    fontSize:    '17px',
    color:       'var(--cream-dim)',
    lineHeight:  1.7,
    textAlign:   'center' as const,
    margin:      0,
  },
  loginBtn: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            '10px',
    width:          '100%',
    padding:        '13px 24px',
    background:     'linear-gradient(135deg, rgba(201,168,76,0.25), rgba(201,168,76,0.1))',
    border:         '1px solid var(--gold)',
    borderRadius:   '8px',
    color:          'var(--gold-bright)',
    fontSize:       '15px',
    fontFamily:     'var(--font-title)',
    letterSpacing:  '0.1em',
    cursor:         'pointer',
    boxShadow:      '0 4px 14px rgba(201,168,76,0.2), inset 0 1px 0 rgba(255,255,255,0.08)',
    marginTop:      '4px',
  },
  cancelBtn: {
    background:    'transparent',
    border:        'none',
    color:         'var(--cream-dim)',
    fontSize:      '13px',
    fontFamily:    'var(--font-title)',
    letterSpacing: '0.08em',
    cursor:        'pointer',
    padding:       '4px 8px',
    opacity:       0.7,
  },
};
