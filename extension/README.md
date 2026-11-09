# AnyCast 浏览器扩展

抓取网页播放器真实请求的视频流（m3u8 / mpd / mp4）以及当时发送的请求头（Referer、Cookie 含 HttpOnly、Authorization 等），交给 AnyCast 网关投到电视。

## 安装

| 浏览器 | 方法 |
|--------|------|
| **Firefox 安卓** | 需要 Firefox 128+。开发调试：手机开 USB 调试后在电脑执行 `npx web-ext run -s extension -t firefox-android`；正式使用：打包（`npx web-ext build -s extension`）后发布到 addons.mozilla.org，在手机 Firefox 里直接安装。 |
| **Edge 安卓等 Chromium 系安卓浏览器** | 部分浏览器在开发者选项中允许按扩展 ID 或安装包安装扩展，具体入口以各浏览器当前版本为准；也可以先用书签脚本。 |
| **Safari（iOS / iPadOS / macOS）** | 在 Mac 上执行 `xcrun safari-web-extension-converter extension/`，用 Xcode 构建到 iPhone，再在“设置 → Safari → 扩展”中启用并允许所有网站。 |
| **电脑 Chrome / Edge** | 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `extension/` 目录。 |
| **电脑 Firefox** | `about:debugging` → 此 Firefox → 临时载入附加组件 → 选择 `extension/manifest.json`。 |

安装后打开扩展设置，填写网关地址（例如 `http://192.168.1.10:8090`）。

## 使用

1. 打开视频网页，**先点播放**（很多播放器在播放时才请求真实地址）。
2. 点网页右下角的“📺 投屏 (n)”悬浮按钮（或工具栏里的扩展图标）。
3. 选择视频和电视 → 投屏到电视。

抓不到视频时，点“交给网关深度解析”，网关会用 HTML 解析 / yt-dlp / 无头浏览器再试一次。

## 工作原理

- `sniffer.js`：在页面 JS 环境中 hook `fetch`、`XMLHttpRequest`、`MediaSource`、EME（检测 DRM）、`<video>.src`。
- `background.js`：用 `webRequest` 记录每个媒体请求的真实请求头和响应类型，按标签页聚合排序。
- `content.js`：桥接消息，显示悬浮按钮。
- `popup.*`：投屏面板；投屏时用 `cookies` 接口补上 HttpOnly 登录 Cookie。

## 权限说明

| 权限 | 用途 |
|------|------|
| `<all_urls>` | 在任意视频网站嗅探；访问局域网网关 |
| `webRequest` | 读取媒体请求的 URL、请求头、Content-Type（只读，不拦截不修改） |
| `cookies` | 投屏时读取视频地址对应的 Cookie，交给网关回放 |
| `storage` | 保存网关地址等设置 |
| `tabs` | 在新标签页打开投屏面板、识别当前标签页 |

所有数据只发送到你自己配置的局域网网关。
