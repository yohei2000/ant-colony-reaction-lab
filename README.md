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
npm.cmd run check
npm.cmd run start
```

検証スクリプトは headless Chrome または Edge を使い、デスクトップとスマホ幅でスクリーンショットと WebGL canvas の非空ピクセル確認を行います。

```powershell
npm.cmd run verify
```

## GitHub Pages

`.github/workflows/deploy.yml` で GitHub Pages に配信します。リポジトリの Pages は `GitHub Actions` 配信モードに設定済みです。
