/**
 * components/TableListModal.tsx — トーナメントのテーブル一覧モーダル
 *
 * PC・スマホ縦・スマホ横の3レイアウトで同じJSXが重複していた問題を解消するため、
 * 共通コンポーネントとして抽出した。
 */

import React from 'react';

export interface TableListPlayer {
  name:        string;
  chips:       number;
  isSelf:      boolean;
  sittingOut:  boolean;
}

export interface TableListData {
  tableId:  string;
  players:  TableListPlayer[];
}

interface Props {
  open:     boolean;
  loading:  boolean;
  data:     TableListData[];
  onClose:  () => void;
}

export default function TableListModal({ open, loading, data, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position:'fixed',inset:0,background:'rgba(0,0,0,0.75)',
        display:'flex',alignItems:'center',justifyContent:'center',
        zIndex:9000,padding:16,
      }}
    >
      <div style={{
        background:'linear-gradient(160deg,rgba(18,60,38,0.97),rgba(8,38,24,0.99))',
        border:'1px solid var(--gold-dim)',borderRadius:12,padding:'20px 24px',
        width:'100%',maxWidth:480,maxHeight:'80vh',overflowY:'auto',
        boxShadow:'0 8px 40px rgba(0,0,0,0.8)',
      }}>
        {/* ヘッダー */}
        <div style={{
          display:'flex',alignItems:'center',justifyContent:'space-between',
          marginBottom:16,paddingBottom:12,
          borderBottom:'1px solid rgba(201,168,76,0.2)',
        }}>
          <span style={{
            fontFamily:'var(--font-title)',fontSize:13,
            letterSpacing:'0.3em',color:'var(--gold)',
          }}>
            テーブル一覧
          </span>
          <button
            onClick={onClose}
            style={{
              background:'none',border:'1px solid var(--gold-dim)',borderRadius:5,
              color:'var(--gold-dim)',cursor:'pointer',fontSize:13,padding:'2px 9px',
            }}
          >
            ✕
          </button>
        </div>

        {loading && (
          <div style={{textAlign:'center',color:'var(--cream-dim)',padding:'32px 0'}}>
            読み込み中...
          </div>
        )}

        {!loading && data.length === 0 && (
          <div style={{textAlign:'center',color:'var(--cream-dim)',padding:'32px 0'}}>
            テーブル情報を取得できませんでした
          </div>
        )}

        {!loading && data.map((tbl, ti) => {
          const isMine = tbl.players.some(p => p.isSelf);
          return (
            <div
              key={tbl.tableId}
              style={{
                marginBottom:12,
                border:`1px solid ${isMine ? 'var(--gold)' : 'rgba(201,168,76,0.2)'}`,
                borderRadius:8,overflow:'hidden',
              }}
            >
              <div style={{
                background: isMine ? 'rgba(201,168,76,0.15)' : 'rgba(0,0,0,0.3)',
                padding:'6px 12px',display:'flex',alignItems:'center',gap:8,
              }}>
                <span style={{
                  fontFamily:'var(--font-title)',fontSize:11,
                  letterSpacing:'0.15em',
                  color: isMine ? 'var(--gold)' : 'var(--cream-dim)',
                }}>
                  Table {ti + 1}
                </span>
                {isMine && (
                  <span style={{
                    fontSize:10,color:'var(--gold)',
                    background:'rgba(201,168,76,0.2)',
                    border:'1px solid var(--gold-dim)',
                    borderRadius:3,padding:'1px 6px',
                  }}>
                    ★ 自テーブル
                  </span>
                )}
                <span style={{
                  marginLeft:'auto',fontSize:11,
                  color:'var(--cream-dim)',fontFamily:'var(--font-body)',
                }}>
                  {tbl.players.length}人
                </span>
              </div>
              <div>
                {[...tbl.players].sort((a, b) => b.chips - a.chips).map((p, pi) => (
                  <div
                    key={pi}
                    style={{
                      display:'flex',alignItems:'center',justifyContent:'space-between',
                      padding:'7px 14px',
                      borderTop:'1px solid rgba(255,255,255,0.05)',
                      background: p.isSelf ? 'rgba(201,168,76,0.08)' : 'transparent',
                    }}
                  >
                    <span style={{
                      fontFamily:'var(--font-body)',fontSize:13,
                      color: p.isSelf ? 'var(--gold-bright)'
                           : p.sittingOut ? 'rgba(255,255,255,0.35)'
                           : 'var(--cream)',
                    }}>
                      {p.isSelf ? '▶ ' : ''}{p.name}{p.sittingOut ? ' (待機)' : ''}
                    </span>
                    <span style={{
                      fontFamily:'var(--font-title)',fontSize:13,
                      color: p.isSelf ? '#88ee88' : 'var(--cream-dim)',
                    }}>
                      {p.chips.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
