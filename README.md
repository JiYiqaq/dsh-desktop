# dsh-desktop — DeepSeek Harness 桌面壳

> **本项目由 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）开发**：
> 需求、功能设计、代码实现、测试验证与打包发布均由 DSH（DeepSeek-V4 编码代理）在其 Web GUI 会话中完成，
> 用户负责提需求与最终验收。项目本身是 DSH Web GUI 的 Electron 桌面壳。

Electron 壳，把 DSH Web GUI（http://127.0.0.1:3080）做成独立桌面应用：

- **独立窗口**：无地址栏/菜单栏，独立任务栏图标（DSH 官方黑色鲸鱼 logo），双击即开
- **托盘驻留**：关窗口 = 最小化到托盘；托盘图标单击切换显隐，右键菜单「退出」才真正退出
- **静默自启**：`--silent` 参数 + 注册表 Run 键，开机自动驻托盘不弹窗口（见下）
- **检查更新**：两个入口——托盘菜单「检查 DSH 更新…」+ 主窗口左下角设置按钮上方的「↻ 检查更新」文字胶囊按钮（preload 注入，fixed 定位跟随设置按钮，不修改 DSH 本体、不参与其布局；配色随页面明暗主题自适应，新版亮红点）→ 独立更新窗口，对比本机与 npm 最新版，一键更新（临时实例切换镜像 → 重启 3080 → 同步 autostart fallback）；启动后静默检查一次，有新版弹托盘气泡 + 按钮亮红点
- **服务自愈**：启动时探测 3080，没起就自动 `spawn dsh web`，就绪后自动加载；只清理自己起的服务，绝不动外部服务
- **单实例保护**：重复双击只激活已有窗口
- **smoke 模式**：无头验证用（见下）

## 使用

```powershell
npm start          # 开发模式直接跑
npm run dist       # 打包 NSIS 安装器（输出到 dist\）
```

打包产物：`dist\DeepSeek Harness Setup <version>.exe` — 安装器（可选安装路径，建桌面/开始菜单快捷方式）。

### DSH 更新（内置）

托盘菜单 →「检查 DSH 更新…」→ 更新窗口点「一键更新」。流程：拉取新版并以临时端口 3081 启动（把 DSH 的 profiles Junction 镜像切到新版）→ 重启 3080（计划任务 watchdog 拉起新版，页面短暂中断属正常，窗口会自动刷新）→ 同步 `autostart\launch-dsh-web.ps1` 里写死的 fallback 版本号。检查源：官方 registry 优先，npmmirror 镜像兜底；全部进度实时显示在更新窗口。

### 开机静默自启（默认到托盘）

自启用注册表 Run 键（登录会话内启动；GUI 应用不能用计划任务 S4U——窗口/托盘会落在 Session 0 看不到）：

```powershell
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"  # 安装版路径
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
  -Name 'DeepSeekHarnessDesktop' -Value "`"$exe`" --silent"
# 取消自启：
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'DeepSeekHarnessDesktop'
```

`--silent` 含义：启动后窗口保持隐藏、只驻托盘，服务照常探测/自愈；点托盘图标才显示窗口。手动双击 exe（不带 `--silent`）仍是正常弹窗启动。

## 顶层默认值（`main.js`，可用环境变量覆盖）

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_DESKTOP_URL` | `http://127.0.0.1:3080` | 探测与加载的目标 URL |
| `DSH_HOME` | `%LOCALAPPDATA%\DeepSeek-Harness` | 用于定位 `dsh` 的 bin.js 与 icon 源图 |
| `DSH_WORKDIR` | 用户主目录 | spawn `dsh web` 的工作目录（会话工作区） |
| `DSH_DESKTOP_SMOKE` | 空 | `1` = smoke 模式：验证后退出，不建窗口 |
| `DSH_DESKTOP_SMOKE_OUT` | 空 | smoke 结果 JSON 的输出路径 |
| `DSH_DESKTOP_USERDATA` | 空 | userData 覆盖（调试/测试与正式实例隔离用） |

命令行参数：`--silent` 静默驻托盘启动（自启用）；`--remote-debugging-port=<n>` 开 CDP 调试口（验证用）。

运行时日志在 `%APPDATA%\DeepSeek Harness\dsh-desktop.log`（壳）与 `dsh-service.log`（自愈起的服务）。

## smoke 验证（不碰正在用的 3080）

```powershell
# 分支 1：服务已在运行 → serviceUp:true，不 spawn
$env:DSH_DESKTOP_SMOKE='1'; $env:DSH_DESKTOP_SMOKE_OUT="$PWD\smoke-up.json"
.\node_modules\.bin\electron.cmd . ; Get-Content smoke-up.json

# 分支 2：服务未运行（指向空闲端口）→ 自动 spawn `dsh web --port 3081` 并等到就绪
$env:DSH_DESKTOP_URL='http://127.0.0.1:3081'; $env:DSH_DESKTOP_SMOKE_OUT="$PWD\smoke-heal.json"
.\node_modules\.bin\electron.cmd . ; Get-Content smoke-heal.json
```

## 目录

```
main.js             主进程：窗口 / 托盘 / 单实例 / 服务探测自愈 / smoke / --silent / 更新
preload-inject.js   主窗口注入：设置按钮上方「↻ 检查更新」按钮 + 新版红点
preload-update.js   更新窗口 IPC 桥（contextBridge，最小暴露）
update.html/update.js 更新窗口界面（检查 / 一键更新 / 进度日志）
assets/icon.ico     应用与托盘图标（DSH 官方鲸鱼，16~256px）
render-icon.js      从 DSH favicon.svg 渲染鲸鱼图标（sharp；node render-icon.js [输出目录] [DSH_HOME]）
cdp-shot.js/cdp-eval.js CDP 验证工具（截图 / DOM 断言，GUI 验证用）
package.json        electron-builder 打包配置
```

## 图标说明

`assets/icon.ico` 由 `render-icon.js` 从 DSH 官方 Web GUI 的 `favicon.svg`（DSH 安装目录
`$DSH_HOME\profiles\node_modules\@deepseek-ai\dsh-web-frontend\dist\favicon.svg`）渲染生成，仅供本项目作为
DSH 桌面壳的图标使用，商标权利归 DeepSeek 所有。

## 已知边界

- 系统通知、全局快捷键未做（列入 v2）
- 开机自启不接管 DSH Web 服务本身：可沿用计划任务 `DeepSeekHarness-Web-Autostart`，桌面壳探测到 3080 在跑就直接连，两者良性共存
- 托盘图标的通知气泡需 v2 对接 Web GUI 的 websocket 事件
- 无自动更新（壳自身升级 = 重打包后覆盖安装，同一 appId，数据/自启保留）

## License

[MIT](LICENSE)
