# 🃏 my-poker-app

ドローポーカー対戦Webアプリ（Next.js + Socket.IO）

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで http://localhost:3000 を開く

## ファイル構成

```
my-poker-app/
├── components/
│   ├── DrawPokerRoom.tsx   # ポーカーゲーム画面
│   ├── Room.tsx            # ロビー画面
│   └── DefaultRoom.tsx     # 未対応ルーム用
├── pages/
│   ├── _document.tsx       # Google Fonts 読み込み
│   ├── index.tsx           # トップページ（ロビー）
│   └── room/
│       └── [roomId].tsx    # ルームページ
├── server/
│   ├── index.js            # Express + Socket.IO サーバー（統合）
│   └── poker/
│       ├── deck.js         # デッキ生成・シャッフル
│       ├── gameManager.js  # ゲーム状態管理
│       └── handEvaluator.js# 役判定
├── socket.ts               # クライアント共通ソケット
├── styles/
│   └── globals.css
├── package.json
├── tsconfig.json
└── next.config.js
```

## ゲームの流れ

1. ロビーで部屋を選択・名前を入力して入室
2. 「カードを配る」ボタンで5枚配布
3. 交換したいカードを選択して「交換する」
4. 全員交換完了でショーダウン → 役と勝者を表示
5. 「もう一度プレイ」で再戦
