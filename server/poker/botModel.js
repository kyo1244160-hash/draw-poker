'use strict';
/**
 * server/poker/botModel.js
 * ONNX モデル推論ラッパー
 *
 * 起動時に全モデル（2ゲームタイプ×2ネット＝4セッション）を
 * suspended 状態でロードし、推論リクエストに応じて使い分ける。
 *
 * 依存: onnxruntime-web（npm install で追加済み）
 * モデルファイル: models/model_{name}_{strategy|draw}.onnx
 */

const path = require('path');
const fs   = require('fs');
const { log, logDev } = require('../logger');

// onnxruntime-web をサーバーサイドで使用
const ort  = require('onnxruntime-web');

// WASM ファイルのパスを明示設定（Node.js 実行時は dist/ から読む）
const { pathToFileURL } = require('url');
const wasmDir = path.join(__dirname, '../../node_modules/onnxruntime-web/dist/');
ort.env.wasm.wasmPaths = pathToFileURL(wasmDir).href;

// モデルディレクトリ
const MODEL_DIR = path.join(__dirname, '../../models');

// ゲームタイプごとの設定
const CONFIGS = {
  '27':     { strategy: 'model_27td_strategy.onnx',   draw: 'model_27td_draw.onnx',   handSize: 5 },
  'badugi': { strategy: 'model_badugi_strategy.onnx', draw: 'model_badugi_draw.onnx', handSize: 4 },
};

// セッションキャッシュ
const _sessions = {};

/**
 * 指定ゲームタイプのセッションを取得（なければロード）
 * @param {string} mode - '27' | 'badugi'
 * @returns {{ strategy: InferenceSession, draw: InferenceSession, handSize: number } | null}
 */
async function getSession(mode) {
  const cfg = CONFIGS[mode];
  if (!cfg) return null;

  if (_sessions[mode]) return _sessions[mode];

  const strategyPath = path.join(MODEL_DIR, cfg.strategy);
  const drawPath     = path.join(MODEL_DIR, cfg.draw);

  if (!fs.existsSync(strategyPath) || !fs.existsSync(drawPath)) {
    logDev(`[BotModel] ${mode}: モデルファイルが見つかりません → ルールベースで動作`);
    return null;
  }

  try {
    log(`[BotModel] ${mode}: モデルをロード中...`);
    const [strategySession, drawSession] = await Promise.all([
      ort.InferenceSession.create(strategyPath, { executionProviders: ['wasm'] }),
      ort.InferenceSession.create(drawPath,     { executionProviders: ['wasm'] }),
    ]);
    _sessions[mode] = { strategy: strategySession, draw: drawSession, handSize: cfg.handSize };

    // メタ情報をログ出力
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'model_meta.json'), 'utf-8'));
      const steps = meta[mode === '27' ? '27td' : mode]?.steps ?? '?';
      log(`[BotModel] ${mode}: ロード完了 (steps=${steps.toLocaleString()})`);
    } catch {
      log(`[BotModel] ${mode}: ロード完了`);
    }

    return _sessions[mode];
  } catch (err) {
    log(`[BotModel] ${mode}: ロードエラー → ルールベースで動作 (${err.message})`);
    return null;
  }
}

/**
 * strategy_net による行動選択
 * @param {string} mode          - '27' | 'badugi'
 * @param {Float32Array} infoState - 122次元ベクトル
 * @param {string[]} legalActions  - 合法アクション ['fold','check','call','bet','raise']
 * @returns {Promise<string | null>} - 選択されたアクション（失敗時 null）
 */
async function predictBetAction(mode, infoState, legalActions) {
  const sess = await getSession(mode);
  if (!sess) return null;

  try {
    const tensor = new ort.Tensor('float32', infoState, [1, 122]);
    const result = await sess.strategy.run({ input: tensor });
    const logits = Array.from(result.output.data);

    // softmax
    const maxL = Math.max(...logits);
    const exps  = logits.map(l => Math.exp(l - maxL));
    const sumE  = exps.reduce((s, e) => s + e, 0);
    const probs  = exps.map(e => e / sumE);

    // アクション対応: 0=fold 1=check 2=call 3=bet 4=raise
    const ACTION_IDX = { fold:0, check:1, call:2, bet:3, raise:4 };

    // 合法アクションのみでargmax
    let bestAction = null;
    let bestProb   = -1;
    for (const action of legalActions) {
      const idx = ACTION_IDX[action];
      if (idx === undefined) continue;
      if (probs[idx] > bestProb) {
        bestProb   = probs[idx];
        bestAction = action;
      }
    }

    logDev(`[BotModel] ${mode} bet probs: ${probs.map((p,i)=>`${i}:${p.toFixed(3)}`).join(' ')} → ${bestAction}`);
    return bestAction;
  } catch (err) {
    logDev(`[BotModel] predictBetAction error: ${err.message}`);
    return null;
  }
}

/**
 * draw_net によるドロー判断
 * @param {string} mode          - '27' | 'badugi'
 * @param {Float32Array} infoState - 122次元ベクトル
 * @returns {Promise<number[] | null>} - 捨てるカードインデックス配列（失敗時 null）
 */
async function predictDraw(mode, infoState) {
  const sess = await getSession(mode);
  if (!sess) return null;

  try {
    const tensor = new ort.Tensor('float32', infoState, [1, 122]);
    const result = await sess.draw.run({ input: tensor });
    const probs  = Array.from(result.output.data); // sigmoid 済み

    // 0.3以上のインデックスを捨てる（0.5から緩和: borderlineケースをカバー）
    const discardIndices = probs
      .slice(0, sess.handSize)
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p >= 0.3)
      .map(({ i }) => i);

    log(`[DRAW-PROB] ${mode} probs: ${probs.map((p,i)=>`${i}:${p.toFixed(3)}`).join(' ')} → discard[${discardIndices.join(',')}]`);
    return discardIndices;
  } catch (err) {
    logDev(`[BotModel] predictDraw error: ${err.message}`);
    return null;
  }
}

/**
 * 起動時に全モデルをプリロードする（サーバー起動時に呼ぶ）
 */
async function preloadAll() {
  for (const mode of Object.keys(CONFIGS)) {
    await getSession(mode).catch(err => {
      log(`[BotModel] preload ${mode} failed: ${err.message}`);
    });
  }
}

module.exports = { predictBetAction, predictDraw, preloadAll, getSession };
