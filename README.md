# Insta360 SOG XR Viewer

PlayCanvasとWebXRを使い、Insta360 Spatial CaptureのSOG形式3D Gaussian SplatをブラウザとVRヘッドセットで表示するビューアーです。

## Live viewer

- [GitHub Pages](https://afjk.github.io/insta360-sog-xr-viewer/)
- [ChatGPT Sites版](https://insta360-sog-xr-viewer.afjk01.chatgpt.site/)

## Controls

### VR

- 左スティック: 視線方向を基準に移動
- 右スティック: 旋回
- Grip + 右スティック: 視線方向を基準に移動
- A: 上昇
- B: 下降

VR開始時に、PICO向けの「滑らかさ優先」と100万点の「高画質」を選べます。

### Desktop

- WASD: 移動
- E / Q: 上下移動
- Shift: 高速移動
- ドラッグ: 視点回転
- ホイール: 距離変更

## SOG assets

- `public/capture.sog`: オリジナル版、100万点、約15.5 MiB
- `public/capture-vr.sog`: VR向け軽量版、50万点、約5.9 MiB

## Development

Node.js 22.13以降が必要です。

```bash
npm install
npm run dev
```

```bash
npm run build
npm run build:pages
npm test
```

`main` ブランチへのpushで、GitHub ActionsがGitHub Pages版を自動更新します。
