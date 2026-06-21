# 蟻の群れリアクションラボ 3D

スマホ操作を前提にした Three.js 製の 3D 蟻シミュレータです。水、落下物、餌、枝をフィールドに置き、個体ごとの性格と状態遷移を観察できます。

## 操作

- 観察: 1本指ドラッグでカメラ回転、タップで個体選択、2本指でズーム
- 水: タップまたはドラッグで水たまりを作成
- 物: タップで落下物を投下
- 餌: タップで餌を配置
- 枝: ドラッグで障害物を配置
- 消す: タップまたはドラッグで配置物を削除

## ローカル確認

```powershell
npm.cmd run build
npm.cmd run check
npm.cmd run start
```

検証スクリプトは headless Chrome または Edge を使い、デスクトップとスマホ幅でスクリーンショットと WebGL canvas の非空ピクセル確認を行います。

```powershell
npm.cmd run verify
```

## 品質設定

通常起動では端末幅と pointer 種別から `medium` / `high` を選びます。手動確認は query parameter で行えます。

- `?quality=low`
- `?quality=medium`
- `?quality=high`
- `?debug=1` で renderer.info、frame time、quality selector を表示

設定は `localStorage` の `ant3d.quality` に保存されます。

## アセット

現状は手続き生成のみです。GLB/KTX2 などの追加方針は [docs/asset-pipeline.md](docs/asset-pipeline.md) に記載しています。

## GitHub Pages

`.github/workflows/deploy.yml` で GitHub Pages に配信します。リポジトリの Pages は `GitHub Actions` 配信モードに設定済みです。
