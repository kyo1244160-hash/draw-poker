"""
scripts/convert_model.py — .pth → .onnx 変換スクリプト

【使い方】
  python scripts/convert_model.py

【実行タイミング】
  - 新しい .pth を models/ に配置した後にローカルで手動実行する
  - Render のビルドコマンドには含めない（.onnx を git 管理するため）

【出力ファイル】
  models/model_badugi_strategy.onnx
  models/model_badugi_draw.onnx
  models/model_27td_strategy.onnx
  models/model_27td_draw.onnx
  models/model_meta.json  ← ステップ数・変換日時
"""

import os, sys, json
from datetime import datetime, timezone

import torch
import torch.nn as nn

# ============================================================
# モデルアーキテクチャ（学習コードと完全一致させる）
# ============================================================

class ResBlock(nn.Module):
    def __init__(self, size):
        super().__init__()
        self.block = nn.Sequential(
            nn.Linear(size, size),
            nn.LayerNorm(size),
            nn.ReLU(),
            nn.Dropout(0.1),
            nn.Linear(size, size),
            nn.LayerNorm(size),
        )
        self.relu = nn.ReLU()

    def forward(self, x):
        return self.relu(x + self.block(x))


class ResNetInner(nn.Module):
    """state_dict のキーが `xxx.net.proj` 形式に対応するラッパー"""
    def __init__(self, in_size, hidden, out_size, num_blocks=4):
        super().__init__()
        self.proj   = nn.Sequential(nn.Linear(in_size, hidden), nn.LayerNorm(hidden))
        self.blocks = nn.ModuleList([ResBlock(hidden) for _ in range(num_blocks)])
        self.head   = nn.Linear(hidden, out_size)

    def forward(self, x):
        x = torch.relu(self.proj(x))
        for b in self.blocks:
            x = b(x)
        return self.head(x)


class ResNet(nn.Module):
    def __init__(self, in_size, hidden, out_size, num_blocks=4):
        super().__init__()
        self.net = ResNetInner(in_size, hidden, out_size, num_blocks)

    def forward(self, x):
        return self.net(x)


class DrawNetwork(nn.Module):
    """
    draw_net: 122次元入力を global_part(70) と hand_part(52) に分割して処理
    出力: hand_size 次元の sigmoid（各カードを捨てる確率）
    global_enc / hand_enc は .net. なしのキーを持つため ResNetInner を直接使用
    """
    def __init__(self, global_in: int, hand_size: int, hidden: int = 512):
        super().__init__()
        self.global_enc = ResNetInner(global_in, hidden // 2, hidden // 2, num_blocks=2)
        self.hand_enc   = ResNetInner(52,        hidden // 2, hidden // 2, num_blocks=1)
        self.output = nn.Sequential(
            nn.Linear(hidden, hidden // 2),
            nn.LayerNorm(hidden // 2),
            nn.ReLU(),
            nn.Linear(hidden // 2, hand_size),
            nn.Sigmoid(),
        )

    def forward(self, x):
        # x: [batch, 122]
        # hand_part: インデックス 18〜69（52次元）
        # global_part: それ以外（70次元）
        hand_part   = x[:, 18:70]
        global_part = torch.cat([x[:, :18], x[:, 70:]], dim=1)
        g = self.global_enc(global_part)
        h = self.hand_enc(hand_part)
        return self.output(torch.cat([g, h], dim=1))


class DeepCFRModel(nn.Module):
    def __init__(self, hand_size: int = 4, hidden_size: int = 512, info_state_size: int = 122):
        super().__init__()
        self.advantage_net = ResNet(info_state_size, hidden_size, 5, num_blocks=4)
        self.strategy_net  = ResNet(info_state_size, hidden_size, 5, num_blocks=4)
        self.draw_net      = DrawNetwork(info_state_size - 52, hand_size, hidden_size)

    def get_strategy(self, info_state: torch.Tensor) -> torch.Tensor:
        return torch.softmax(self.strategy_net(info_state), dim=-1)

    def get_draw_probs(self, info_state: torch.Tensor) -> torch.Tensor:
        return self.draw_net(info_state)


# ============================================================
# 変換処理
# ============================================================

CONFIGS = {
    'badugi': {'pth': 'models/model_badugi.pth', 'hand_size': 4},
    '27td':   {'pth': 'models/model_27td.pth',   'hand_size': 5},
}

def convert(name, cfg):
    pth_path = cfg['pth']
    if not os.path.exists(pth_path):
        print(f'[{name}] スキップ: {pth_path} が見つかりません')
        return None

    print(f'[{name}] 読み込み中: {pth_path}')
    data = torch.load(pth_path, map_location='cpu', weights_only=False)
    steps = data.get('adv_train_steps', 0)

    model = DeepCFRModel(hand_size=cfg['hand_size'])
    model.load_state_dict(data['model_state_dict'])
    model.eval()

    dummy = torch.zeros(1, 122)

    # strategy_net を変換（単一ファイル形式）
    strategy_path = f'models/model_{name}_strategy.onnx'
    torch.onnx.export(
        model.strategy_net, dummy, strategy_path,
        input_names=['input'], output_names=['output'],
        opset_version=17,
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    )
    # 外部 .data ファイルを単一ファイルに統合
    import onnx
    m = onnx.load(strategy_path)
    onnx.save(m, strategy_path, save_as_external_data=False)
    print(f'[{name}] strategy → {strategy_path}')

    # draw_net を変換（単一ファイル形式）
    draw_path = f'models/model_{name}_draw.onnx'
    torch.onnx.export(
        model.draw_net, dummy, draw_path,
        input_names=['input'], output_names=['output'],
        opset_version=17,
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    )
    m = onnx.load(draw_path)
    onnx.save(m, draw_path, save_as_external_data=False)
    print(f'[{name}] draw    → {draw_path}')
    print(f'[{name}] 完了 (steps={steps:,})')
    return steps


def main():
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    meta = {}
    for name, cfg in CONFIGS.items():
        steps = convert(name, cfg)
        if steps is not None:
            meta[name] = {
                'steps': steps,
                'converted_at': datetime.now(timezone.utc).isoformat(),
            }

    with open('models/model_meta.json', 'w') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print(f'\nmodel_meta.json 更新完了: {list(meta.keys())}')


if __name__ == '__main__':
    main()
