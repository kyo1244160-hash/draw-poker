# ADR-003: gameManager.js はソケットを知らない

- **日付**: 2024-03（初期実装時）
- **ステータス**: 採用

## コンテキスト

ゲームロジック（役判定・フェーズ遷移・ポット計算）とネットワーク処理（Socket.IO の emit/broadcast）を同じ場所に書くと、テストが困難になり責務が混在する。

## 決定

`server/poker/gameManager.js` は `io`（Socket.IO インスタンス）や `socket` を一切受け取らない。状態変更のみを行い、`_broadcast()` は `server/index.js` が担当する。

```js
// gameManager.js: io を知らない
function betAction(roomId, socketId, action) {
  const room = rooms.get(roomId);
  // ... 状態変更のみ
  return room; // 変更後の room を返す
}

// index.js: broadcast を担当
socket.on('betAction', ({ roomId, action }) => {
  const room = betAction(roomId, socket.id, action);
  if (room) _broadcast(io, roomId); // ← ここで emit
});
```

## 結果

**利点**:
- gameManager の関数は純粋に近い（入力 → 状態変更 → 戻り値）
- ロジックのデバッグが容易（`rooms` Map を直接検査できる）
- 将来的にユニットテストを書きやすい

**欠点**:
- `index.js` が複雑になる（全ソケットハンドラが集中）
- `broadcast` のタイミング制御が `index.js` に分散する
