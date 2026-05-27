/**
 * components/MyPageModal.tsx — マイページモーダル
 *
 * 表示内容:
 *   - リングゲーム累積損益グラフ（SVG折れ線）
 *   - モード別成績テーブル
 *   - 通算サマリー
 */

import { useEffect, useState, useCallback } from 'react';
import { modeLabelFull, modeColor as getModeColor } from '../lib/modeLabels';

// ===== 型定義 =====
interface HistoryPoint {
  hand_seq:   number;
  net:        number;
  cumulative: number;
  mode:       string;
  played_at:  string;
}

interface ModeStats {
  mode:  string;
  net:   number;
  hands: number;
}

interface Summary {
  net:   number;
  hands: number;
}

// ===== ユーティリティ =====
const modeLabel = modeLabelFull;
const modeColor = getModeColor;

function fmtNet(n: number) {
  if (n === 0) return '±0';
  return (n > 0 ? '+' : '') + n.toLocaleString();
}

// ===== SVGグラフ =====
function LineGraph({ history }: { history: HistoryPoint[] }) {
  if (history.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--cream-dim)', fontSize: 13, padding: '40px 0' }}>
        まだリングゲームの記録がありません
      </div>
    );
  }

  const W = 560, H = 200, PAD = { top: 16, right: 16, bottom: 28, left: 56 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const values = history.map(h => h.cumulative);
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values);
  const range  = maxVal - minVal || 1;

  const xOf = (i: number) => PAD.left + (i / Math.max(history.length - 1, 1)) * innerW;
  const yOf = (v: number) => PAD.top + innerH - ((v - minVal) / range) * innerH;
  const y0  = yOf(0);

  // 折れ線パス
  const linePath = history
    .map((h, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(h.cumulative).toFixed(1)}`)
    .join(' ');

  // 塗りつぶしパス（ゼロラインで閉じる）
  const fillPath =
    `M${xOf(0).toFixed(1)},${y0.toFixed(1)} ` +
    history.map((h, i) => `L${xOf(i).toFixed(1)},${yOf(h.cumulative).toFixed(1)}`).join(' ') +
    ` L${xOf(history.length - 1).toFixed(1)},${y0.toFixed(1)} Z`;

  // Y軸グリッド（5本）
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = minVal + (range / 4) * i;
    return { v: Math.round(v), y: yOf(Math.round(v)) };
  });

  const lastVal = values[values.length - 1] ?? 0;
  const isPositive = lastVal >= 0;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {/* グリッド */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line
            x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y}
            stroke="rgba(255,255,255,0.07)" strokeWidth={1}
          />
          <text
            x={PAD.left - 6} y={t.y + 4}
            textAnchor="end" fontSize={10} fill="rgba(255,255,255,0.4)"
          >
            {t.v >= 1000 ? `${(t.v / 1000).toFixed(1)}k` : t.v <= -1000 ? `${(t.v / 1000).toFixed(1)}k` : t.v}
          </text>
        </g>
      ))}

      {/* ゼロライン */}
      <line
        x1={PAD.left} y1={y0} x2={W - PAD.right} y2={y0}
        stroke="rgba(255,255,255,0.25)" strokeWidth={1} strokeDasharray="4,3"
      />

      {/* 塗りつぶし */}
      <path
        d={fillPath}
        fill={isPositive ? 'rgba(100,200,120,0.15)' : 'rgba(220,80,80,0.15)'}
      />

      {/* 折れ線 */}
      <path
        d={linePath}
        fill="none"
        stroke={isPositive ? '#66cc88' : '#cc5566'}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* 最後の点 */}
      <circle
        cx={xOf(history.length - 1)}
        cy={yOf(lastVal)}
        r={3.5}
        fill={isPositive ? '#66cc88' : '#cc5566'}
      />

      {/* X軸ラベル（ハンド数） */}
      {[0, Math.floor(history.length / 2), history.length - 1].map((idx) => (
        idx >= 0 && idx < history.length ? (
          <text
            key={idx}
            x={xOf(idx)} y={H - 6}
            textAnchor="middle" fontSize={10} fill="rgba(255,255,255,0.4)"
          >
            {history[idx].hand_seq}
          </text>
        ) : null
      ))}
    </svg>
  );
}

// ===== メインコンポーネント =====
interface Props {
  onClose: () => void;
}

export default function MyPageModal({ onClose }: Props) {
  const [history,  setHistory]  = useState<HistoryPoint[]>([]);
  const [stats,    setStats]    = useState<{ summary: Summary; byMode: ModeStats[] } | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, hRes] = await Promise.all([
        fetch('/api/ring/stats'),
        fetch('/api/ring/history?limit=1000'),
      ]);
      if (!sRes.ok || !hRes.ok) throw new Error('データ取得失敗');
      const [sData, hData] = await Promise.all([sRes.json(), hRes.json()]);
      setStats(sData);
      setHistory(hData.history ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'エラーが発生しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ESC で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const summary = stats?.summary ?? { net: 0, hands: 0 };
  const byMode  = stats?.byMode  ?? [];
  const netColor = summary.net > 0 ? '#66cc88' : summary.net < 0 ? '#cc5566' : 'var(--cream-dim)';

  return (
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.modal}>
        {/* ヘッダー */}
        <div style={S.header}>
          <span style={S.title}>MY PAGE</span>
          <button onClick={onClose} style={S.closeBtn}>✕</button>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', color: 'var(--cream-dim)', padding: '48px 0' }}>
            読み込み中...
          </div>
        )}

        {error && (
          <div style={{ textAlign: 'center', color: '#cc5566', padding: '48px 0' }}>
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {/* サマリー */}
            <div style={S.summaryRow}>
              <div style={S.summaryCard}>
                <div style={S.summaryLabel}>通算損益</div>
                <div style={{ ...S.summaryValue, color: netColor }}>{fmtNet(summary.net)}</div>
              </div>
              <div style={S.summaryCard}>
                <div style={S.summaryLabel}>総ハンド数</div>
                <div style={S.summaryValue}>{summary.hands.toLocaleString()}</div>
              </div>
            </div>

            {/* グラフ */}
            <div style={S.section}>
              <div style={S.sectionTitle}>累積損益グラフ（直近{history.length}ハンド）</div>
              <div style={S.graphWrap}>
                <LineGraph history={history} />
              </div>
            </div>

            {/* モード別成績 */}
            {byMode.length > 0 && (
              <div style={S.section}>
                <div style={S.sectionTitle}>モード別成績</div>
                <div style={S.modeTable}>
                  {byMode.map(m => {
                    const nc = m.net > 0 ? '#66cc88' : m.net < 0 ? '#cc5566' : 'var(--cream-dim)';
                    return (
                      <div key={m.mode} style={S.modeRow}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ ...S.modeDot, background: modeColor(m.mode) }} />
                          <span style={S.modeName}>{modeLabel(m.mode)}</span>
                        </div>
                        <span style={{ ...S.modeNet, color: nc }}>{fmtNet(m.net)}</span>
                        <span style={S.modeHands}>{m.hands} hands</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ===== スタイル =====
const S: Record<string, React.CSSProperties> = {
  overlay: {
    position:        'fixed',
    inset:           0,
    background:      'rgba(0,0,0,0.72)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          9000,
    padding:         '16px',
  },
  modal: {
    background:    'linear-gradient(160deg, rgba(18,60,38,0.97), rgba(8,38,24,0.99))',
    border:        '1px solid var(--gold-dim)',
    borderRadius:  14,
    boxShadow:     '0 8px 48px rgba(0,0,0,0.8), var(--inset)',
    width:         '100%',
    maxWidth:      620,
    maxHeight:     '90vh',
    overflowY:     'auto',
    padding:       '24px 28px',
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   20,
    borderBottom:   '1px solid rgba(201,168,76,0.2)',
    paddingBottom:  14,
  },
  title: {
    fontFamily:    'var(--font-title)',
    fontSize:      15,
    letterSpacing: '0.35em',
    color:         'var(--gold)',
  },
  closeBtn: {
    background:  'none',
    border:      '1px solid var(--gold-dim)',
    borderRadius: 6,
    color:       'var(--gold-dim)',
    cursor:      'pointer',
    fontSize:    14,
    padding:     '3px 10px',
    lineHeight:  1,
  },
  summaryRow: {
    display:       'flex',
    gap:           16,
    marginBottom:  20,
  },
  summaryCard: {
    flex:          1,
    background:    'rgba(0,0,0,0.3)',
    border:        '1px solid rgba(201,168,76,0.2)',
    borderRadius:  8,
    padding:       '14px 18px',
    textAlign:     'center',
  },
  summaryLabel: {
    fontFamily:  'var(--font-body)',
    fontSize:    11,
    color:       'var(--cream-dim)',
    marginBottom: 6,
    letterSpacing: '0.05em',
  },
  summaryValue: {
    fontFamily: 'var(--font-title)',
    fontSize:   22,
    color:      'var(--cream)',
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontFamily:    'var(--font-title)',
    fontSize:      11,
    letterSpacing: '0.25em',
    color:         'var(--gold-dim)',
    marginBottom:  10,
  },
  graphWrap: {
    background:   'rgba(0,0,0,0.25)',
    border:       '1px solid rgba(201,168,76,0.15)',
    borderRadius: 8,
    padding:      '12px 8px 4px',
    overflowX:    'auto',
  },
  modeTable: {
    display:       'flex',
    flexDirection: 'column',
    gap:           6,
  },
  modeRow: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    background:     'rgba(0,0,0,0.25)',
    border:         '1px solid rgba(201,168,76,0.12)',
    borderRadius:   7,
    padding:        '10px 14px',
  },
  modeDot: {
    display:      'inline-block',
    width:        9,
    height:       9,
    borderRadius: '50%',
    flexShrink:   0,
  },
  modeName: {
    fontFamily: 'var(--font-body)',
    fontSize:   13,
    color:      'var(--cream)',
  },
  modeNet: {
    fontFamily: 'var(--font-title)',
    fontSize:   14,
    minWidth:   70,
    textAlign:  'right',
  },
  modeHands: {
    fontFamily: 'var(--font-body)',
    fontSize:   12,
    color:      'var(--cream-dim)',
    minWidth:   64,
    textAlign:  'right',
  },
};
