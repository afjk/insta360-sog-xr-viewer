# Insta360 SOG XR Viewer

PlayCanvasとWebXRを使い、Insta360 Spatial CaptureのSOG形式3D Gaussian SplatをブラウザとVRヘッドセットで表示するビューアーです。

## Live viewer

- [GitHub Pages](https://afjk.github.io/insta360-sog-xr-viewer/)
- [ChatGPT Sites版](https://insta360-sog-xr-viewer.afjk01.chatgpt.site/)

## 空間を読み込む

ページを開くと、サンプルの `capture.sog` が自動で読み込まれます。SOGファイルを持っていなくても、
そのままビューアーを試せます。画面右上のバッジで、いまサンプルを表示していることが分かります。

「空間を開く」ボタンから、3通りの方法で任意のSOGに切り替えられます。

- **ドラッグ＆ドロップ**: `.sog` ファイルをページのどこにドロップしても読み込めます。
- **ファイルを選択**: OSのファイル選択ダイアログからローカルの `.sog` を指定します。
- **`.sog` のURL**: 直接ダウンロードできる `.sog` のURLを指定します（配信元がCORSを許可している必要があります）。
- **Insta360共有URL**: Spatial Captureの共有ページURL（例:
  `https://app.insta360.com/3dspace/detail/GS3DG...`）を貼り付けます。解決には
  サーバー側のエンドポイントが必要です。下記を参照してください。
- **`?id=` 付きのViewer URL**: 一度開いた空間はリンクとして配れます。
  [空間を別の端末へ渡す](#空間を別の端末へ渡す)を参照してください。

読み込んだ空間はDesktopでもWebXRでも閲覧でき、「サンプルに戻す」でいつでも元に戻せます。

### 空間を別の端末へ渡す

Insta360共有URLから読み込むと、アドレスバーが自動でViewer専用のリンクになります。

```
https://afjk.github.io/insta360-sog-xr-viewer/?id=GS3DGbfd0ddd0dd4a47ccba4d3d2c2eed8a4d
```

このURLをQuestやPICOのブラウザで開くと、**サンプルを経由せず**その空間だけを読み込みます。
画面右下の「この空間のリンクをコピー」で同じURLをクリップボードへ入れられます。

載せるのは共有ID (`GS3DG…`) だけです。解決した署名付きSOGのURLには有効期限と
`x-oss-signature` が付いているので、アドレスバーにも共有リンクにも出しません。開くたびに
resolverが取り直します。

URLの組み立ては `URL` / `URLSearchParams` で行うので、GitHub Pagesのサブパス配信でも
localhostでも、開いているのと同じ配信先のリンクになります。サンプル・ローカルファイル・
`.sog` の直接URLへ切り替えると、古い `?id=` は消えます。

`id` の形が合わない場合はネットワークへ出さず、通常どおりサンプルを表示します。実装は
`app/permalink.ts` にまとまっています。

### Insta360共有URLの解決について

Insta360の共有ページはブラウザからのクロスオリジン取得を許可しないため、共有URLの解決だけを
サーバー側（`GET /api/insta360`）が担当します。SOG本体は中継しません。

共有ページはNext.jsで、生成済みアセットの署名付きURLが `__NEXT_DATA__` に最初から入っています。

```
props.pageProps.taskDetail.outputs
  ├─ 0_3DGS.ply        fileFormat: "ply"
  ├─ 1_3DGS.sog        fileFormat: "sog"   ← これを使う
  ├─ 2_cameras.json
  ├─ 3_3DGS.voxel.zip
  └─ 4_effect_*.mp4
```

resolverは2段構えでこの `outputs` を取りに行き、`fileFormat === "sog"` のURLを返します。

1. **タスク詳細API** — 共有ページ自身が使っているエンドポイントを直接叩きます。

   ```
   GET https://service-g.insta360.com/app-service/app/service/gs3d/task/detail?taskOrderNo=<共有ID>
   → { "code": 0, "data": { "outputs": [ ... ] } }
   ```

   リージョンは共有IDの5文字目で決まります（`C` は `service-c`、`G` は `service-g`、
   判別できなければ両方に問い合わせて先に成功した方を使う）。HTMLより構造が安定しているので、
   こちらを先に試します。

2. **共有ページのHTML** — APIが失敗したときは `__NEXT_DATA__` を読みます。`taskDetail` の
   位置が変わった場合に備えてURLを持つ配列を探すフォールバックと、`__NEXT_DATA__` 自体が
   無い場合のHTML走査も残してあります。

Next.jsは埋め込みJSON中の `&` を `\u0026` として書き出すため、テキストのまま正規表現で
URLを抜くと署名クエリが壊れます。`JSON.parse` を通すことでこれを回避しています。

署名付きURLには有効期限（`x-oss-expires`）があるので、解決結果は保存せず毎回取り直します。
IndexedDBへ載せるのは変換済みのVR向けSOGだけです。

どちらの経路もサーバー側でしか使えません。共有ページも詳細APIも
`access-control-allow-origin` をInsta360のオリジンにしか返さないためです
（詳細APIは `Origin: https://app.insta360.com` にだけCORSヘッダーを付けて応答します）。

一方、**解決後の署名付きSOG URLはCORSを許可しています**（`access-control-allow-origin: *`、
Rangeリクエストも可）。そのためresolverは解決したURLを返すだけで、ブラウザがそこから直接
SOGを取得します。

```
ブラウザ ──共有URL──> resolver ──task/detail API──> 署名付きSOGのURL
   │                     └──────URLを返すだけ──────┘
   └──────────────GET──────────────> p2-app.insta360.com/…/1_3DGS.sog
```

15MB前後のSOGがWorkerを通らないので、Workerの転送量はほぼゼロで済みます。`content-length` は
CORSセーフリストのレスポンスヘッダーなので、直接取得でも進捗表示は働きます。

同じ理由で、署名付きURLさえ手元にあればresolverを経由せず「`.sog` のURL」欄へ貼るだけでも
読み込めます。resolverを立てられない環境での抜け道になります。

同じ共有ページからは `0_3DGS.ply` も取得できます。現在のビューアーはSOGのみを扱います。

#### 解決エンドポイントの配置

共有URLの解決先はコードに直接書かず、ビルド時に `VITE_SOG_RESOLVER_ORIGIN` で渡します。

| 値 | 動作 |
| --- | --- |
| 未設定 | 同一オリジンの `/api/insta360` を使う（Cloudflare Worker版） |
| `none` | 解決エンドポイントを持たない配信。共有URLの入力を無効にし、理由を表示する |
| URL | そのオリジンの `/api/insta360` を使う（専用Workerなど） |

GitHub Pagesは静的配信で `/api` を持たないため、`vite.pages.config.ts` が既定で `none` を入れます。

#### GitHub Pages用のresolver Worker

`resolver-worker/` に、共有URLの解決だけを行う単機能のCloudflare Workerがあります。
解決ロジックはアプリ本体のWorkerと共有しています。

```bash
npm run resolver:dev      # ローカルで動かす
npm run resolver:deploy   # Cloudflareへデプロイ
```

デプロイしたら、リポジトリの **Settings → Secrets and variables → Actions → Variables** で
`SOG_RESOLVER_ORIGIN` にWorkerのオリジン（例: `https://insta360-sog-resolver.<account>.workers.dev`）を
設定し、Pagesワークフローを再実行してください。ビルドがそれを拾い、共有URLの入力が有効になります。

この変数が未設定のあいだ、GitHub Pages版は共有URLの入力を無効にしたままビルドされ、
「この配信にはInsta360共有URLを解決するエンドポイントがありません」と表示します。
これは設定の問題で、解決処理そのものの不具合ではありません。それまでは
`.sog` ファイルのドロップか、署名付き `.sog` URLの直接指定で読み込めます。

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

- 左ドラッグ: 回転（部屋の中心を軸に回ります）
- 右ドラッグ / 中ドラッグ / Shift + 左ドラッグ: 平行移動
- ホイール: ズーム（回転の中心に寄る・引く）
- ダブルクリック: 視点をリセット
- WASD: 移動
- E / Q: 上下移動
- Shift: 高速移動

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

この選び方は **SOGのストリームがsplat-transformの並び順（空間的に近いsplatが連続する）を
保っていることを前提** にしています。Insta360 Spatial Capture由来のSOGはこれを満たします。
並び順が空間的でないSOGでは、選ばれるsplat数は変わりませんが、バケットが空間的にまとまらない
ため間引きの分布が偏りうる点に注意してください。あらゆるSOGへ広げる場合は、meansをデコードして
Morton順に並べ直してからバケットを切る方式へ移す必要があります。

再エンコードにPNGを使うのは、CanvasのWebPエンコーダが画素をアルファ乗算済みで保持するためです。
SOGはアルファに不透明度や量子化モードを詰めているので、Canvasを経由すると値が壊れます。
画像の読み出しも同じ理由で、WebGL2のreadPixelsを使っています。splat-transformが出力する
ロスレスWebPよりは2割ほど大きくなりますが、1バイトも欠けません。

現在の実装ではWebGPUを使いません。必要なのはOffscreenCanvas / WebGL2 / createImageBitmap /
CompressionStreamで、いずれかが欠けている環境では最適化のみを無効にし、理由を表示したうえで
オリジナルのままVRを開始できます。今回の規模（100万点）ではこの構成で足りていますが、
より大規模なSOGを扱うようになればGPU支援を検討する余地はあります。

### 実測

Chromium + SwiftShader（ソフトウェアGL）で `capture.sog` を変換したときの値です。

#### 変換そのもの（キャッシュが効くのはこの部分）

| 項目 | 値 |
| --- | --- |
| 入力 | 15.5 MiB / 1,000,000 splats |
| 出力 | 7.0 MiB / 500,000 splats |
| SOG decode | 421 ms |
| decimation | 101 ms |
| SOG encode | 1,116 ms |
| **変換合計** | **1,678 ms** |

#### VR開始までの準備時間（変換 + SOGの読み込み）

「最適化してVRを開始」を押してからVRを開始できる状態になるまでの総時間です。
変換に加えて、生成したSOGのPNG展開・テクスチャ転送・centers生成が含まれます。

| | 総時間 | 内訳 |
| --- | --- | --- |
| 初回（変換あり） | 9.3 s | 変換 1.7 s + SOGの読み込み ~7.6 s |
| キャッシュヒット（変換なし） | 8.1 s | IndexedDB読み出し 1 ms + SOGの読み込み ~8.1 s |

キャッシュが省くのは変換の1.7秒だけで、残る約8秒はソフトウェアGLでのSOG読み込みです。
アプリが待機状態であれば同じ読み込みが543 msで終わっているので、この8秒はSwiftShaderが
1M splatの描画と取り合っている分が大半です。実機のGPUではここが大きく縮みます。

変換中は描画を止めてCPU/GPUを変換に回しています（止めない場合、初回は44.7秒でした）。

PICO / Quest実機およびDesktop Safariでの計測は未実施です。

## SOG assets

- `public/capture.sog`: サンプル、100万点、約15.5 MiB
- `public/capture-vr.sog`: splat-transformが出力したVR向け軽量版、50万点、約5.9 MiB

ビューアーが使うのは `capture.sog` だけです。`capture-vr.sog` はビューアーからは読み込まず、
ブラウザ内で生成した軽量SOGと見比べるための参照用として残しています。

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
