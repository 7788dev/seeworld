# Agent Note: GitHub 自动构建与 Release 发布

Status: implemented

## Problem

每次推送都要手动本地打包，容易漏掉便携版或安装器；GitHub 上也没有统一的版本管理入口。需要同时产出免安装 exe、NSIS 安装器和 MSI，并在推送后自动发布。

## Decision

新增 [`.github/workflows/release.yml`](../../.github/workflows/release.yml)：

- `push` 到 `main`：构建并更新滚动预发布 `nightly`（同名资产用 `gh release upload --clobber` 覆盖，tag 指向最新提交）。
- 推送 `vX.Y.Z` tag：构建正式 Release，并把 tag 版本写回 `src-tauri/tauri.conf.json` 与 `Cargo.toml`。
- 构建 `npm run build`（Tauri bundle target `all`）一次产出：
  - `src-tauri/target/release/jianjie.exe` → `SeeWorld-…-portable.exe`
  - `bundle/nsis/*.exe` → `SeeWorld-…-setup.exe`
  - `bundle/msi/*.msi` → `SeeWorld-….msi`
- 用 `gh release upload/create/edit` 直接管理 Release，避免额外自定义 action；资产同时上传 Actions artifact 兜底。
- 发布前运行 `npm test` 与 `cargo test`；tag 版本不合法直接失败。

## Alternatives considered

**只用 tauri-action。** 官方推荐，安装器上传顺畅，但便携 exe 不在 bundle 资产里，需要额外步骤；对滚动 `nightly` 的资产覆盖行为不如 `gh --clobber` 直观。
**用 softprops/action-gh-release。** 能做，但多引入一个第三方 action；`gh` CLI 已由 Windows runner 提供，显式命令更容易审计。
**只在 tag 发布。** 不满足“每次推送都构建发布”的要求。
**每次 main 推送用唯一 nightly tag。** 版本列表会快速膨胀；滚动 `nightly` + tag 移动更干净。
**只出 NSIS。** 用户明确需要“便捷版 + 安装器”，同时保留 MSI 作为系统部署选项。

## Consequences

- `nightly` 是预发布，不占用 Latest；正式版由 `vX.Y.Z` tag 标记 Latest。
- 构建未签名，Windows SmartScreen 可能提示；要消除需配置代码签名证书 secrets。
- 如果 runner 既没产出 NSIS 也没产出 MSI，workflow 直接失败，避免发布只有 exe 的“安装包”。
- `main` 的 `nightly` tag 会被强制移动到最新提交；这是该发布通道的语义，不应同时给 `nightly` 打人工 tag。
- 每次推送都会跑一次完整 Windows release 构建；比普通 CI 慢，但产物可直接下载。