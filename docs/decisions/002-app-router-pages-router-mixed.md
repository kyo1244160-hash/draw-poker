# ADR-002: App Router と Pages Router の混在

- **日付**: 2024-03（トーナメント機能追加時）
- **ステータス**: 採用

## コンテキスト

既存のロビー・通常ルームは Pages Router で実装済み。トーナメントのゲーム画面は `height: 100dvh` の全画面 UI が必要で、Pages Router の `_app.tsx` が挿入するグローバルスタイルやラッパーと干渉する可能性があった。

## 決定

トーナメントのゲーム画面（draw/spectate）は App Router（`app/tournament/[id]/draw/`, `app/tournament/[id]/spectate/`）に配置し、それ以外は Pages Router のまま維持する。

## 結果

**利点**:
- `_app.tsx` の `TournamentStartWatcher` がゲーム中に干渉しない
- 全画面レイアウトをシンプルに実装できる

**欠点**:
- `_app.tsx` の `TournamentStartWatcher` が App Router ページでは動かないため、draw/spectate ページは自前でソケット接続・遷移ロジックを持つ必要がある
- `useSession()` が App Router では使えない → `/api/auth/session` を fetch で代替
- 将来的に App Router に全移行する場合、ロジックの重複整理が必要

## 注意点

App Router ページに遷移ロジックを追加する際は、`_app.tsx` の処理と二重にならないよう注意すること。特に `t:tournamentStarting` の受信と `router.push` は両方で実装されているため、どちらが実行されるかを意識する。
