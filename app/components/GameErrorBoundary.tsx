'use client';
// app/components/GameErrorBoundary.tsx
// ゲーム画面専用エラーバウンダリ
// - エラー詳細（stack trace）を画面に表示してコピー可能にする
// - /api/debug/client-error へ POST してサーバーログに残す

import React from 'react';

interface Props {
  children: React.ReactNode;
  label?: string; // どのコンポーネントをラップしているか（デバッグ用）
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  copied: boolean;
}

export default class GameErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, copied: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo });

    // サーバーのログに送信（Render ダッシュボールで確認可能）
    const payload = {
      label:      this.props.label ?? 'unknown',
      message:    error.message,
      stack:      error.stack ?? '',
      component:  errorInfo.componentStack ?? '',
      url:        typeof window !== 'undefined' ? window.location.href : '',
      ua:         typeof navigator !== 'undefined' ? navigator.userAgent : '',
      ts:         new Date().toISOString(),
    };

    fetch('/api/debug/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* サーバー送信失敗は無視 */ });

    // console にも出力（ブラウザ DevTools で確認可能）
    console.error('[GameErrorBoundary]', error, errorInfo);
  }

  handleCopy = () => {
    const { error, errorInfo } = this.state;
    const text = [
      `=== Error ===`,
      error?.message ?? '(no message)',
      '',
      `=== Stack ===`,
      error?.stack ?? '(no stack)',
      '',
      `=== Component Stack ===`,
      errorInfo?.componentStack ?? '(no component stack)',
      '',
      `=== URL ===`,
      typeof window !== 'undefined' ? window.location.href : '',
      `=== UA ===`,
      typeof navigator !== 'undefined' ? navigator.userAgent : '',
    ].join('\n');

    navigator.clipboard?.writeText(text).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 3000);
    });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { error, errorInfo, copied } = this.state;

    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(5,10,5,0.97)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: 20, overflowY: 'auto',
        fontFamily: 'monospace',
      }}>
        <div style={{
          width: '100%', maxWidth: 600,
          background: '#0d1a0d', border: '1px solid #cc3333',
          borderRadius: 12, padding: '20px 20px',
        }}>
          {/* タイトル */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 24 }}>🚨</span>
            <div>
              <div style={{ color: '#ff6666', fontSize: 16, fontWeight: 700 }}>
                クライアントエラーが発生しました
              </div>
              {this.props.label && (
                <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>
                  場所: {this.props.label}
                </div>
              )}
            </div>
          </div>

          {/* エラーメッセージ */}
          <div style={{
            background: 'rgba(200,50,50,0.12)', border: '1px solid rgba(200,50,50,0.3)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 12,
          }}>
            <div style={{ color: '#ff9999', fontSize: 13, wordBreak: 'break-all' }}>
              {error?.message ?? '(no message)'}
            </div>
          </div>

          {/* スタックトレース */}
          <div style={{
            background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 12,
            maxHeight: 200, overflowY: 'auto',
          }}>
            <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, marginBottom: 4 }}>
              Stack Trace:
            </div>
            <pre style={{
              color: '#ffcc88', fontSize: 10, margin: 0,
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {error?.stack ?? '(no stack)'}
            </pre>
          </div>

          {/* コンポーネントスタック */}
          {errorInfo?.componentStack && (
            <div style={{
              background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 8, padding: '10px 14px', marginBottom: 16,
              maxHeight: 150, overflowY: 'auto',
            }}>
              <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, marginBottom: 4 }}>
                Component Stack:
              </div>
              <pre style={{
                color: '#88ccff', fontSize: 10, margin: 0,
                whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                {errorInfo.componentStack}
              </pre>
            </div>
          )}

          {/* ボタン */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={this.handleCopy}
              style={{
                flex: 1, padding: '10px 16px',
                background: copied ? '#1a6b3a' : 'rgba(255,255,255,0.08)',
                border: `1px solid ${copied ? '#2a9b5a' : 'rgba(255,255,255,0.2)'}`,
                borderRadius: 8, color: copied ? '#88ffaa' : '#ffffff',
                fontSize: 13, cursor: 'pointer',
                fontFamily: 'monospace',
              }}
            >
              {copied ? '✅ コピーしました' : '📋 エラーをコピー'}
            </button>
            <button
              onClick={this.handleReload}
              style={{
                flex: 1, padding: '10px 16px',
                background: 'rgba(50,100,200,0.2)',
                border: '1px solid rgba(50,100,200,0.4)',
                borderRadius: 8, color: '#88aaff',
                fontSize: 13, cursor: 'pointer',
                fontFamily: 'monospace',
              }}
            >
              🔄 ページを再読み込み
            </button>
          </div>

          {/* サーバー送信済み通知 */}
          <div style={{
            marginTop: 12, textAlign: 'center',
            color: 'rgba(255,255,255,0.3)', fontSize: 10,
          }}>
            ⬆️ このエラーはサーバーログにも自動送信されました（Render Logs で確認可能）
          </div>
        </div>
      </div>
    );
  }
}
