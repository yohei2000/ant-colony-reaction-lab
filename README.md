# 蟻の群れリアクションラボ 3D

Three.js + Vite + TypeScript で作った、モバイル前提の 3D アリコロニー観察シミュレータです。

小さな巣と 12 匹のアリから始まり、水・物・餌・枝への反応、フェロモン、放置成長、アップグレード、敵コロニー遠征バトルを 1 つの軽量な Web ゲームとして動かします。

## 開発

```powershell
npm.cmd install
npm.cmd run dev
```

## 検証

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd run asset:audit
npm.cmd run verify
```

`npm run verify` は Vite dev server を起動し、Playwright で `390x844` と `1366x768` を確認します。canvas の非空チェック、`renderer.info`、初期 12 匹、hover だけではカメラが動かないこと、フェロモン減衰、放置成長、アップグレード、遠征、保存復元、モバイル横はみ出しを検証します。

## GitHub Pages

Vite の `base` は `/ant-colony-reaction-lab/` に設定済みです。GitHub Actions で Pages に配信できます。

公開 URL:

```text
https://yohei2000.github.io/ant-colony-reaction-lab/
```
