import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // server/db/* は Node.js 専用モジュール（postgres）を使うため
  // クライアントバンドルから除外する
  serverExternalPackages: ["postgres", "socket.io", "express"],

  // API ルートのタイムアウト設定
  experimental: {},
};

export default nextConfig;
