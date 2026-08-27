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
- **SuperSplat公開シーンURL**: `https://superspl.at/scene/56155c3f` または
  `https://superspl.at/s?id=56155c3f` を貼り付けます。**作者がダウンロードを許可した
  公開シーンのみ対応**します。こちらも解決にはサーバー側のエンドポイントが必要です。
  詳しくは[SuperSplat公開シーンURLの解決について](#supersplat公開シーンurlの解決について)を
  参照してください。
- **`?id=` / `?ss=` 付きのViewer URL**: 一度開いた空間はリンクとして配れます。
  [空間を別の端末へ渡す](#空間を別の端末へ渡す)を参照してください。視点ごと渡したいときは
  [視点ごと渡す](#視点ごと渡すview)を参照してください。

読み込んだ空間はDesktopでもWebXRでも閲覧でき、「サンプルに戻す」でいつでも元に戻せます。

### 空間を別の端末へ渡す

Insta360共有URLやSuperSplatのシーンURLから読み込むと、アドレスバーが自動で
Viewer専用のリンクになります。載るのは提供元ごとの恒久的なIDだけです。

```
https://afjk.github.io/insta360-sog-xr-viewer/?id=GS3DGbfd0ddd0dd4a47ccba4d3d2c2eed8a4d
https://afjk.github.io/insta360-sog-xr-viewer/?ss=56155c3f
```

| パラメータ | 提供元 | 値 |
| --- | --- | --- |
| `id` | Insta360 Spatial Capture | 共有ID (`GS3DG…`) |
| `ss` | SuperSplat | シーンID (`56155c3f`) |

`id` と `ss` の両方が載った異常なURLでは、**先に配ってある `id` を優先**し、`ss` は
無視します。片方だけが有効で、`id` の形が合わなければ `ss` へは落ちずサンプルを
表示します。

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

### 視点ごと渡す（`view=`）

`?id=` だけのリンクはその空間の既定視点で開きます。**いま見えている場所と向き**ごと渡したい
ときは、画面右下の「この視点のリンクをコピー」を使います。

```
https://afjk.github.io/insta360-sog-xr-viewer/?id=GS3DG…&view=1_-1.234_1.62_3.5_137.5_-4.58_2.8
```

`view=` は版数と6つの数値です。区切りの `_` は `URLSearchParams` がエンコードしない文字なので、
リンクはそのまま読める長さに収まります。

| 位置 | 値 | 内容 |
| --- | --- | --- |
| 1 | `1` | フォーマットの版数 |
| 2–4 | `x` / `y` / `z` | world空間の視点（eye）の位置。m、小数点以下3桁 |
| 5 | `yaw` | 水平向き。度、`-180`〜`180`。PlayCanvasのY軸オイラー角と同じ符号 |
| 6 | `pitch` | 見下ろし角。度、正で見下ろし。Desktop表示にだけ使う |
| 7 | `distance` | Orbitの回転半径。m |

Viewer内部のカメラは `desktopTarget`（rig座標のOrbit中心）・`yaw`・`pitch`・`distance`・rigの
位置に分かれていて、WASDでrigごと動いたあとは同じ `desktopTarget` でも別の場所を指します。
リンクに載せるときはこれをworld空間のeyeへ畳んでから書き出すので、**panしたあとも、WASDで
移動したあとも、実際に見えている位置**が保存されます。復元側はrigを原点へ戻し、eyeと
`yaw` / `pitch` / `distance` から逆にOrbitの中心を割り出します。

載るのはカメラの姿勢だけです。署名付きSOGのURLや認証情報は `?id=` のときと同様に入りません。
数値が壊れている・桁が合わない・値域を外れている場合はその視点を捨て、通常の既定視点で開きます
（空間そのものは開けます）。

### Quest / WebXRでの初期視点

視点リンクはDesktopだけのものではありません。同じURLをQuestで開いて「VRを開始」すると、
**Desktopで指定したのと同じ場所・同じ水平向き**からVRが始まります。

WebXRではXRセッション中のカメラのposition / rotationがHMDのtracking poseで毎フレーム
上書きされるため、カメラへ直接視点を書いても消えます。動かせるのは親の `rig` だけなので、

```
rig * HMD pose = 目的の視点
```

を満たす `rig` を解いて入れます（`app/view-pose.ts` の `xrRigOffset`）。

1. `xr.start(...)` の直前に、いまDesktopに見えている視点を控える
2. rigは一度identityへ戻す
3. XRセッション開始後、**最初にHMDのposeが入ったフレーム**でrigを1回だけ補正する
   （PlayCanvasはviewer poseを取れなかったフレームでは `app.update` ごと飛ばすので、
   `app.on("update")` が呼ばれた時点でカメラには有効なposeが入っています）
4. 補正は水平回転 `yawOffset = desiredYaw - currentHeadYaw` をrigのY回転に入れ、
   rigの位置は `desiredPosition - R * currentHeadPosition` にする

`XRSPACE_LOCALFLOOR` のposeには、ユーザーの実際の頭の高さとroom-space原点からのずれが
すでに入っています。そのため `rig.position = desiredPosition` のような単純代入はしません。
高さも差分（`desiredEyeY - currentHeadY`）で入れるので、Desktopで目線1.6mの視点を指定した
リンクは、Questでもほぼ同じ高さから始まります。その後の実際の頭の上下移動は、通常どおり
WebXRのtrackingがそのまま反映します。

合わせるのは**位置と水平yawだけ**です。VRではユーザー本人が頭を上下・左右に傾けているので、
保存したpitch / rollでHMDの姿勢を上書きすることはありません。補正は1回きりなので、スティックの
移動・旋回といった既存のlocomotionはそのまま動きます。VRを抜けて入り直したときも同じ規則で
spawnします。

実機で確かめるときは `?debug=1` を足して開きます。VRを開始した直後に、狙った視点・
そのときのHMD pose・入れたrigの姿勢・実際に組み上がったカメラのworld姿勢が
`[sog-xr] spawn` / `[sog-xr] spawned` としてconsoleへ1回だけ出ます。DesktopとQuestで
同じURLを開いて、位置の差が数cm〜10cm、yawの差が数度に収まっていれば合っています
（Desktop側の値は `view=` の数値そのものです）。付けなければ何も出ません。

### 初期視点の優先順位

DesktopとQuestで同じ規則を使います。

1. URLに `view=` がある … ユーザーが指定した視点
2. Insta360共有で `2_cameras.json` が取れる … 公式Viewerと同じ初期視点（下記）
3. どちらも無い … 読み込んだ空間の広がりから決める `frameBounds()`

判定は `SogViewer.tsx` の `linkedViewFor()` と `homeViewFor()` に分かれていて、どちらも
`null` を返すと `frameBounds()` へ落ちます。2で決まった視点はアドレスバーには載せません
（`?id=` だけのリンクが、勝手に視点付きのリンクへ化けないようにするため）。

どれが使われたかは `?debug=1` で開くと分かります。空間を読み込んだ直後に、分位点バウンズ・
splatの配置・届いたカメラ情報の件数・決まった視点・画角が `[sog-xr] initial` として
consoleへ出ます。`cameraCount` が `null` なら `cameras.json` が届いておらず、3へ落ちています
（配信中のresolver Workerが古い、共有が期限切れ、`.sog` の直接指定、などが原因）。

#### `cameras.json` が無いときの既定視点

`frameBounds()` は、splat重心の分位点バウンズ（2–98%）から目線の高さと引きの距離を決め、
**重心の中央値**を回転の中心に置きます。中心に箱の中点を使わないのは、屋外のキャプチャでは
分位点バウンズでさえ大半が遠景（向かいのビルや空）で埋まり、中点が歩いた範囲の外——
建物の中——へ落ちるためです。実データでは、ある夜間の街路キャプチャで箱の中点が撮影地点から
水平に約5.7mずれ、開いた直後が真っ暗になっていました。中央値ならsplatが密なところ、つまり
撮影した場所の近くに留まります。

splatの**配置**（`applyPlacement()`）は箱の中点のままです。ここを動かすとworld座標が変わり、
既に配ったリンクの `view=` が別の場所を指してしまいます。

#### 公式Viewerと同じ初期視点

resolverはタスク詳細の `outputs` から `2_cameras.json`（撮影時のカメラ情報）の署名付きURLを
`camerasUrl` として返します。

```json
{ "shareId": "GS3DG…", "assetUrl": "https://p2-app.insta360.com/…/1_3DGS.sog?…", "camerasUrl": "https://p2-app.insta360.com/…/2_cameras.json?…" }
```

このJSONは配信元が `access-control-allow-origin: *` を返すので、SOGと同じくブラウザから
直接取ります（SOGと並行して取得。失敗しても3へ落ちるだけで、空間は表示できます）。中身は
3DGS標準の `cameras.json` で、実データは1件がこの形でした。

```json
{ "id": 0, "img_name": "frame_00000_cam1_center", "width": 1000, "height": 1000,
  "position": [-2.7597, -0.0070, -4.4427], "rotation": [[…], […], […]], "fx": 500, "fy": 500 }
```

- `position` はカメラ中心のworld座標、`rotation` はcamera-to-worldの回転（COLMAP/OpenCVの
  向き。+Zが前、+Yが下）。座標系はSOGの重心と同じで、スケールも揃っています。
- 実データは1274件で、`frame_00000`〜`frame_00079` の実フレーム（cam1/cam2 × 5〜6面）に
  加えて、フレーム間を補間した `*_pseudo` が並びます。
- `outputs` 上の `type` はSOGやPLYと同じ `"model"` なので、型では選別できません。選別は
  ファイル名で行っています（`selectCamerasOutput`）。

公式Viewer（`/_next/static/chunks/4348.*.js`＝`src/pages/3dgs/remy/kiriCameraControls.js` の
`calculateCameraProfile()`）は、このファイルから初期視点をこう決めています。

- eye … `cameras[0].position`（撮り始めた場所）
- 注視点 … **全カメラ位置の平均**（歩き回った軌跡の中心）
- 画角 … `cameras[0]` の `2·atan(width / 2fx)` と `2·atan(height / 2fy)`

向きが `cameras[0].rotation` ではなく eye→注視点で決まるのが要点です（最初のフレームが
向いていた方向ではなく、撮った範囲の中心を見る構図になります）。この実装は
`app/capture-view.ts` の `captureHomeView()` にあります。

座標系は公式とこちらで違いますが、構図は変わりません。公式はメッシュにもカメラにも
`scale(-1, -1, 1)`（Z軸まわり180°）を掛けるだけで、こちらは `splatEntity` のX軸180°回転＋
bounds由来の平行移動（部屋を原点へ、床をy=0へ）を掛けます。カメラ位置をsplatと同じ変換へ
通すので、両者はY軸まわり180°と平行移動の差にしかならず、eyeから見える絵は一致します。
変換は `splatPlacement()` / `worldFromCapturePoint()` にまとめてあり、`applyPlacement()` も
同じ関数を見ています。

画角は撮影画角をそのまま垂直画角にはできない（画面の縦横比で水平方向の写り方が変わる）ため、
公式と同じ規則で決めます。垂直を合わせても水平が撮影画角を下回らないなら垂直基準、下回るなら
水平基準（ただし90°まで）。実データは 1000×1000 / fx=fy=500 なので水平垂直とも90°で、
Desktopのどの縦横比でも垂直90°になります。`cameras.json` が無い空間は既定の58°のままです。

公式が同じファイルから作っている**Orbitの可動域**（軌跡の広がりから決まる距離と極角・
方位角の制限、およびその範囲へ引き戻すダンピング）は移植していません。こちらのDesktop操作は
`DOLLY_RANGE` / `MAX_PITCH` で足りており、実データでは初期視点が公式の可動域の内側にあって
補正なしで一致します。

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
| 未設定 | 同一オリジンの `/api/insta360` と `/api/supersplat` を使う（Cloudflare Worker版） |
| `none` | 解決エンドポイントを持たない配信。共有URLの入力を無効にし、理由を表示する |
| URL | そのオリジンの `/api/insta360` と `/api/supersplat` を使う（専用Workerなど） |

オリジンは1つで、その下に提供元ごとのパスがぶら下がります。提供元が増えても
ビルド設定（`VITE_SOG_RESOLVER_ORIGIN`）は増えません。

GitHub Pagesは静的配信で `/api` を持たないため、`vite.pages.config.ts` が既定で `none` を入れます。

#### GitHub Pages用のresolver Worker

`resolver-worker/` に、共有URL・シーンURLの解決だけを行う単機能のCloudflare Workerが
あります。`/api/insta360` と `/api/supersplat` の両方を提供し、解決ロジックはアプリ本体の
Workerと共有しています。

```bash
npm run resolver:dev      # ローカルで動かす
npm run resolver:deploy   # Cloudflareへデプロイ
```

**解決ロジックを変えたら、このWorkerも必ず再デプロイしてください。** Pages側のビルドが新しくても
Workerが古いままだと、増えたフィールドがViewerへ届きません。実際、`camerasUrl` を返すように
した後にWorkerを更新し忘れ、公開版だけが公式と違う初期視点で開く状態になっていました。
配信中のWorkerが何を返しているかは、ブラウザを使わずに確かめられます。

```bash
curl "https://insta360-sog-resolver.<account>.workers.dev/api/insta360?url=https://app.insta360.com/3dspace/detail/GS3DG…"
# => {"shareId":"GS3DG…","assetUrl":"…","camerasUrl":"…"}   camerasUrl が無ければ古い版

curl "https://insta360-sog-resolver.<account>.workers.dev/api/supersplat?url=https://superspl.at/scene/56155c3f"
# => {"provider":"supersplat","sceneId":"56155c3f","title":"…","license":{…},"asset":{…}}
# 404 が返るなら SuperSplat 対応前の古い版
```

デプロイしたら、リポジトリの **Settings → Secrets and variables → Actions → Variables** で
`SOG_RESOLVER_ORIGIN` にWorkerのオリジン（例: `https://insta360-sog-resolver.<account>.workers.dev`）を
設定し、Pagesワークフローを再実行してください。ビルドがそれを拾い、共有URLの入力が有効になります。

この変数が未設定のあいだ、GitHub Pages版は共有URLの入力を無効にしたままビルドされ、
「この配信にはInsta360共有URLを解決するエンドポイントがありません」と表示します。
これは設定の問題で、解決処理そのものの不具合ではありません。それまでは
`.sog` ファイルのドロップか、署名付き `.sog` URLの直接指定で読み込めます。

共有ページからSOGのURLを探す処理は `app/insta360.ts` にまとまっています。SuperSplat側は
`app/supersplat.ts` です。URLの安全判定（ループバック・プライベートIP宛を弾く処理）は
両者で共通の `app/url-safety.ts` にあります。

### SuperSplat公開シーンURLの解決について

[SuperSplat](https://superspl.at) の公開シーンも、共有ページがブラウザからの
クロスオリジン取得を許可していないため、解決だけをサーバー側（`GET /api/supersplat`）が
担当します。SOG本体は中継しません。

#### 対応するのは「ダウンロードが許可された公開シーン」だけ

SuperSplatには、作者がManageページで**Downloadable**を有効にしたシーンだけを
ダウンロード可能にする仕組みと、Creative Commonsライセンスを付ける仕組みがあります。
このViewerはその意思表示を尊重します。

処理の順番は固定です。

```
シーンURL
  ↓
公開ページ取得
  ↓
公開メタデータ解析
  ↓
Downloadable判定  ── NO / 判定不能 ──> 読み込まない (403)
  ↓ YES
ライセンス確認    ── 取れない ──────> 読み込まない (422)
  ↓
asset discovery
```

- **Downloadableを確認できない場合は読み込みません**（fail-closed）。「許可されていない」も
  「ページから読み取れなかった」も、同じく読み込まない側に倒します。
- **CDNにデータが存在するという理由だけで取得しません。** シーンIDからCDNを当て推量で
  叩くことはせず、CDNへのアクセスはDownloadable判定を通ったあとにしか起きません。
  Downloadableでないシーンでは、公開ページ以外へは1リクエストも出ません。
- ライセンスは種別を保ったまま扱います（`CC BY 4.0` と `CC BY-NC 4.0` を混同しません）。
  読み取れない場合は推測せず、明示的にエラーにします。

resolverが返す内部エラーコードは次のとおりです。画面に出す日本語とは分けてあります。

| コード | HTTP | 意味 |
| --- | --- | --- |
| `INVALID_SUPERSPLAT_URL` | 400 | SuperSplatのシーンURLではない |
| `SUPERSPLAT_SCENE_NOT_FOUND` | 404 | シーンが見つからない |
| `SUPERSPLAT_NOT_DOWNLOADABLE` | 403 | ダウンロードが許可されていない／確認できない |
| `SUPERSPLAT_LICENSE_NOT_FOUND` | 422 | ライセンスを読み取れない |
| `SUPERSPLAT_ASSET_NOT_FOUND` | 422 | 読み込めるSOGが見つからない |
| `SUPERSPLAT_STREAMED_SOG_UNSUPPORTED` | — | Streamed SOG（Viewer側で判断） |
| `SUPERSPLAT_UNAVAILABLE` | 502 | 公開ページを取得できない |

#### アセットの探し方

SuperSplatの公開ページはオープンソースのViewer
（[`playcanvas/supersplat-viewer`](https://github.com/playcanvas/supersplat-viewer)）で
描かれていて、アセットのURLはページ内の1か所に機械可読な形で埋め込まれています。

```html
<script type="application/json" id="sse-bootstrap">
  {"contentUrl":"https://.../v3/meta.json","contentFilename":"meta.json"}
</script>
```

resolverはここから `contentUrl` を読みます。**CDNのURLを組み立てて探索することは
しません。** リビジョン（`v3` など）も、ページが持っているURLから読むだけです。
取得を許可するホストは明示的な許可リストで絞り、ループバック・プライベートIP・
リンクローカル（メタデータエンドポイントを含む）は弾きます。

#### SOGの形

SuperSplatの公開配信は、単一ファイルの `.sog` とは限りません。

| `asset.format` | 実体 | このViewer |
| --- | --- | --- |
| `sog` | bundled SOG（単一ファイル） | 対応 |
| `sog-meta` | unbundled SOG（`meta.json` ＋ WebP群） | 対応 |
| `streamed-sog` | Streamed SOG（`lod-meta.json`） | **未対応** |

**Streamed SOG（`lod-meta.json`）は現時点では未対応です。** 1M splatsを超える大きな
シーンは自動的にこの形式で配信されるため、それらは開けません。その場合は
「このSuperSplatシーンはストリーミング形式です。現在このViewerでは未対応です。」と
表示します。resolverは `format: "streamed-sog"` をそのまま返すので、対応を足すのは
Viewer側だけで済みます。

unbundled SOGの `meta.json` は、同じディレクトリのWebPを**相対パス**で参照しています。
そのためこの形式だけはBlob化せず、CDNのURLをそのままPlayCanvasへ渡します
（`blob:` のobject URLにすると相対解決の基準が失われ、WebPを取りに行けなくなります）。

その代わり、unbundled SOGでは元データがひと続きのバイト列として手元に残らないため、
**VR向け軽量化は利用できません**（Desktop表示とVRのOriginal表示は通常どおり動きます）。
UIにもその旨を表示します。bundled SOGとInsta360共有では従来どおり軽量化を使えます。

#### 座標系

SuperSplatが配るSOGはInsta360のものと軸の向きが違います。SuperSplat自身の公開Viewerは、
読み込んだgsplatに対して無条件で `entity.setLocalEulerAngles(0, 0, 180)`（Z軸まわり180°）を
掛けています。このViewerも同じ回転をSuperSplat由来の空間に適用します。

| 提供元 | 回転 | 反転する軸 |
| --- | --- | --- |
| Insta360 / サンプル / ローカルファイル / `.sog` 直接URL | X軸まわり180° | y, z |
| SuperSplat | Z軸まわり180° | x, y |

Insta360の変換（X軸180°）をSuperSplatへ流用すると前後が逆になります。配置
（中心合わせと床のy=0合わせ）の約束はどちらも同じで、`app/capture-view.ts` の
`PlacementTransform` として定義してあります。

#### 初期視点

SuperSplatには Insta360 の `cameras.json` に当たるものがありません。初期視点は
`view=` があればそれ、無ければ空間の広がりから決める既定視点（`frameBounds()`）です。
Insta360側の優先順位（`view=` → `cameras.json` → `frameBounds()`）は変わりません。

#### 実装の置き場所

SuperSplat固有の処理は2つのモジュールに閉じ込めてあり、`SogViewer.tsx` には
HTML構造もCDNのホストも出てきません。

| ファイル | 役割 |
| --- | --- |
| `app/supersplat.ts` | URL解析、公開ページの解析、ライセンス正規化、アセット選択 |
| `app/supersplat-resolver.ts` | 処理順の強制、HTTPハンドラ、エラーコード |

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
