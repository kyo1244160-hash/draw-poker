// eslint.config.mjs — eslint@9 対応のシンプルな設定
import { defineConfig } from "eslint/config";

const eslintConfig = defineConfig([
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"],
  },
]);

export default eslintConfig;
