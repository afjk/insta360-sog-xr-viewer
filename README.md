# Insta360 SOG XR Viewer

PlayCanvasとWebXRを使い、Insta360 Spatial CaptureのSOG形式3D Gaussian SplatをブラウザとVRヘッドセットで表示するビューアーです。

## Live viewer

- [GitHub Pages](https://afjk.github.io/insta360-sog-xr-viewer/)
- [ChatGPT Sites版](https://insta360-sog-xr-viewer.afjk01.chatgpt.site/)

## 空間を読み込む

ページを開くと、サンプルの `capture.sog` が自動で読み込まれます。SOGファイルを持っていなくても、
そのままビューアーを試せます。画面右上のバッジで、いまサンプルを表示していることが分かります。

「空間を開く」ボタンから、3通りの方法で任意のSOGに切り替えられます。

- **Insta360共有URL**: Spatial Captureの共有ページURL（例:
  `https://app.insta360.com/3dspace/detail/GS3DG...`）をそのまま貼り付けます。
- **ドラッグ＆ドロップ**: `.sog` ファイルをページのどこにドロップしても読み込めます。
- **ファイルを選択**: OSのファイル選択ダイアログからローカルの `.sog` を指定します。

読み込んだ空間はDesktopでもWebXRでも閲覧でき、「サンプルに戻す」でいつでも元に戻せます。

### Insta360共有URLの解決について

Insta360の共有ページはブラウザからのクロスオリジン取得を許可していないため、共有URLの解決と
SOG本体の中継は `GET /api/insta360` （Cloudflare Worker版）が担当します。GitHub Pages版には
`/api` が無いので、同オリジンで解決できなかった場合はWorker版のエンドポイントへフォールバックします。

共有が期限切れの場合や、共有ページの構造が変わってSOGのURLを見つけられない場合は、その旨を
エラーとして表示します。その場合はSOGファイルをダウンロードして、ドラッグ＆ドロップで読み込んでください。
共有ページからSOGのURLを探す処理は `app/insta360.ts` にまとまっています。

## Controls

### VR

- 左スティック: 視線方向を基準に移動
- 右スティック: 旋回
- Grip + 右スティック: 視線方向を基準に移動
- A: 上昇
- B: 下降

VR開始時に、PICO向けの「滑らかさ優先」と100万点の「高画質」を選べます。
読み込んだSOGでは、描画解像度とフォービエイションのみが切り替わります。

### Desktop

- WASD: 移動
- E / Q: 上下移動
- Shift: 高速移動
- ドラッグ: 視点回転
- ホイール: 距離変更

## SOG assets

同梱しているサンプルは次の2つです。VRの画質選択で切り替わります。

- `public/capture.sog`: オリジナル版、100万点、約15.5 MiB
- `public/capture-vr.sog`: VR向け軽量版、50万点、約5.9 MiB

読み込んだSOGには軽量版が無いため、画質選択はVRの描画解像度のみを切り替えます。

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
