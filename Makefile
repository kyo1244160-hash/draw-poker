# Makefile — Poker Room Pastis よく使うコマンド

.PHONY: dev build start install clean db-schema db-migrate secret help

## デフォルト: ヘルプ表示
help:
	@echo "Poker Room Pastis — コマンド一覧"
	@echo ""
	@echo "  make dev          開発サーバー起動"
	@echo "  make build        Next.js プロダクションビルド"
	@echo "  make start        ビルド + 本番サーバー起動"
	@echo "  make install      依存パッケージインストール"
	@echo "  make clean        .next/ キャッシュ削除"
	@echo "  make secret       NEXTAUTH_SECRET 生成"
	@echo "  make db-schema    スキーマ表示（Supabase に貼り付ける）"
	@echo "  make db-migrate   マイグレーション一覧表示"
	@echo "  make lint         ESLint 実行"
	@echo "  make check-env    必要な環境変数のチェック"

## 開発サーバー起動
dev:
	npm run dev

## Next.js プロダクションビルド
build:
	npm run build

## ビルド + 本番起動
start:
	npm start

## 依存パッケージインストール
install:
	npm install

## .next/ キャッシュ削除（ビルドエラー時に試す）
clean:
	rm -rf .next
	@echo ".next/ を削除しました"

## NEXTAUTH_SECRET 生成
secret:
	@node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

## スキーマ確認（Supabase SQL Editor に貼り付け用）
db-schema:
	@echo "=== schema.sql ==="
	@cat schema.sql

## マイグレーション一覧
db-migrate:
	@echo "=== migrations/ フォルダ内のファイル（適用順） ==="
	@ls -1 migrations/
	@echo ""
	@echo "Supabase Dashboard > SQL Editor で各ファイルを順番に実行してください"

## ESLint 実行
lint:
	npx eslint . --ext .ts,.tsx --max-warnings 0

## 環境変数チェック
check-env:
	@node -e "\
	const required = ['DATABASE_URL','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','NEXTAUTH_SECRET','NEXTAUTH_URL','ALLOWED_ORIGIN','BOT_SECRET'];\
	require('dotenv').config({ path: '.env.local' });\
	const missing = required.filter(k => !process.env[k]);\
	if (missing.length) { console.error('❌ 未設定の環境変数:', missing.join(', ')); process.exit(1); }\
	else { console.log('✅ 必要な環境変数がすべて設定されています'); }\
	"
