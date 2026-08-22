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

VR開始時に「オリジナル」と「VR向けに最適化」を選べます。詳しくは
[VR向けSOGの生成](#vr向けsogの生成)を参照してください。

### Desktop

- WASD: 移動
- E / Q: 上下移動
- Shift: 高速移動
- ドラッグ: 視点回転
- ホイール: 距離変更

## VR向けSOGの生成

Desktop表示は常にオリジナルのSOGを使います。VRでは「オリジナル」と「VR向けに最適化」を
選べ、最適化版はブラウザ内で生成します。SOGを変換のために外部へ送ることはありません。

- 既定の目標splat数は50万点。250K / 500K / 750K / 1M から選べます
- 視点依存の色（SH）は落とします
- 生成はWeb Worker内で行い、進捗と処理段階を表示します
- 生成結果はIndexedDBへキャッシュし、同じSOG・同じ設定なら再変換しません
- キャッシュキーはSOGの中身のSHA-256なので、Insta360共有URL経由でもローカルファイルでも
  同じキャッシュに当たります
- 生成に失敗しても、表示中のオリジナルSOGはそのまま維持されます

### 実装メモ

間引きは「残すsplatを選び、各ストリームの画素を詰め直す」だけで、量子化やコードブックは
オリジナルのまま使い回します。再量子化による劣化はありません。残すsplatは、元データの並び順を
等間隔のバケットに切り、各バケットで最も不透明なものを選びます。

再エンコードにPNGを使うのは、CanvasのWebPエンコーダが画素をアルファ乗算済みで保持するためです。
SOGはアルファに不透明度や量子化モードを詰めているので、Canvasを経由すると値が壊れます。
画像の読み出しも同じ理由で、WebGL2のreadPixelsを使っています。splat-transformが出力する
ロスレスWebPよりは2割ほど大きくなりますが、1バイトも欠けません。

WebGPUは必要ありませんでした。必要なのはOffscreenCanvas / WebGL2 / createImageBitmap /
CompressionStreamで、いずれかが欠けている環境では最適化のみを無効にし、理由を表示したうえで
オリジナルのままVRを開始できます。

### 実測

Chromium + SwiftShader（ソフトウェアGL）で `capture.sog` を変換したときの値です。

| 項目 | 値 |
| --- | --- |
| 入力 | 15.5 MiB / 1,000,000 splats |
| 出力 | 7.0 MiB / 500,000 splats |
| SOG decode | 421 ms |
| decimation | 101 ms |
| SOG encode | 1,116 ms |
| 変換合計 | 1,678 ms |
| PlayCanvasでの読み込み | 543 ms |
| IndexedDBからの読み出し | 1 ms |

ビューアー上で「最適化してVRを開始」を押してからVRを開始できる状態になるまでは、
同じ環境で初回9.3秒、キャッシュヒット時8.1秒でした。どちらも大半はソフトウェアGLでの
テクスチャ展開に費やされており、変換自体は上表のとおり1.7秒です。変換中は描画を止めて
CPU/GPUを変換に回します（止めない場合は初回44.7秒でした）。

ソフトウェアGLでの値なので、実機のGPUではdecodeも読み込みもさらに速くなります。
PICO / Quest実機およびDesktop Safariでの計測は未実施です。

## SOG assets

- `public/capture.sog`: サンプル、100万点、約15.5 MiB

VR向けの軽量SOGは同梱せず、必要になった時点でブラウザ内で生成します。

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
