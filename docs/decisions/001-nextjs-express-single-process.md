# ADR-001: Next.js と Express を単一プロセスで動かす

- **日付**: 2024-03（初期実装時）
- **ステータス**: 採用

## コンテキスト

Render.com の無料プランでは Web Service が1つしか立てられない。Socket.IO サーバーと Next.js を別々のプロセス/サービスに分けることができない。

## 決定

Express サーバー（`server/index.js`）が Next.js の `requestHandler` を組み込み、単一プロセスで両方を動かす。

```js
const app    = next({ dev });
const handle = app.getRequestHandler();

// Express ルーティング
server.all('*', (req, res) => handle(req, res, parse(req.url, true)));
```

## 結果

**利点**:
- Render.com 無料プランで動作する
- 環境変数・ポート設定がシンプル（1つ）
- Socket.IO と Next.js API Routes が同一オリジンで動く（CORS の複雑さが減る）

**欠点**:
- Next.js の開発サーバー（HMR）が使えない（`npm run dev` = `node server/index.js`）
- サーバーサイドのコード変更は毎回再起動が必要
- スケールアウト（複数インスタンス）が困難（Socket.IO の状態共有が必要になる）
