# ADR-005: Sit & Go はスケジューラーを使わず参加登録トリガーで起動する

- **日付**: 2026-04（Sit & Go 実装時）
- **ステータス**: 採用

## コンテキスト

既存のトーナメント自動開始は 60秒ごとの DB スキャン（`_scan()`）で `scheduled_start_at` を過ぎたものを起動する仕組み。Sit & Go は「人数が集まったら即座に開始」という性質があり、スキャンサイクルを待つ最大 60秒の遅延が生じる。

また SNG は時間ベースの開始条件を持たないため、スキャンの対象にすること自体が設計上不自然。

## 決定

SNG の `scheduled_start_at` を `2099-01-01` に設定してスキャンの対象外にする。代わりに参加登録 API（`/api/tournament/[id]/entry` POST）の完了後に `tournamentManager.triggerSitAndGoCheck()` を呼び、エントリー数が `min_players` に達していれば即座に `_launchTournament()` を実行する。

```
entry.ts POST 完了
  → triggerSitAndGoCheck(tournamentId)  ← fire & forget
      → DB: entries >= min_players?
          YES → _launchTournament()     ← 既存関数を流用（変更なし）
          NO  → 何もしない
```

## 結果

**利点**:
- 既存の `_launchTournament()` をそのまま流用できる（トーナメント起動ロジックの変更ゼロ）
- 参加登録と同じリクエストサイクル内でチェックするため遅延がほぼゼロ
- `is_sit_and_go=false` の既存トーナメントには一切影響しない

**欠点**:
- `triggerSitAndGoCheck` は fire & forget なので、失敗してもリトライされない
  - ただし `_launchTournament` は `_scheduled` Set で重複実行を防いでいる
  - 万が一失敗した場合、スキャンで最大 60秒後にリカバリーされる可能性もある（`2099年` なので実際はされないが）
  - 本番で問題になるようであれば `entry.ts` にリトライロジックを追加することを検討

## 将来対応

- `max_players` に達したら即時開始する機能を追加する場合も同じトリガーで対応可能
- SNG のリアルタイム待機人数更新（現状: 30秒ポーリング）を WebSocket push に変更する場合は、`triggerSitAndGoCheck` の後に `io.to(tournamentId).emit('sng:playerJoined', { count })` を追加する
