# AnyCast 设计文档：让手机上任意网页视频都能投到电视

## 1. 问题：为什么“不是所有视频都能投屏”

手机浏览器自带的投屏（Chrome 的 Cast、Safari 的 AirPlay、各家浏览器的“DLNA 投屏”）本质上都只做一件事：**把一个视频 URL 交给电视，让电视自己去下载播放**。电视的播放器是一个“傻”HTTP 客户端，于是出现了下面这些失败原因：

| # | 失败原因 | 现象 | 常见于 |
|---|---------|------|--------|
| 1 | **拿不到真实地址**：`<video>` 的 src 是 `blob:`（MSE 播放），真实的 m3u8/mpd 藏在 JS 请求里 | 浏览器根本不显示投屏按钮 | 几乎所有视频网站（hls.js / dash.js / 各家自研播放器） |
| 2 | **防盗链**：CDN 校验 `Referer` / `Cookie` / `Origin` / 自定义 token 头 | 电视报“无法播放”，实际是 403 | 视频网站、会员内容、网盘 |
| 3 | **跨域（CORS）**：Chromecast 默认接收器用 MSE 拉 HLS/DASH，CDN 不给 `Access-Control-Allow-Origin` | Chromecast 黑屏/加载失败 | 投到 Chromecast / Google TV |
| 4 | **格式不支持**：DASH、音视频分离（B 站等）、FLV、fMP4 HLS、HEVC… | 只有声音/只有画面/直接失败 | 老电视、廉价盒子 |
| 5 | **伪装切片**：TS 切片前面拼一段 PNG/JPG 文件头逃避 CDN 审查 | 网页能播（hls.js 容错），电视花屏或失败 | 各类聚合站 |
| 6 | **链接有时效 / 绑定会话** | 解析出来的地址过一会就失效 | 签名 URL |
| 7 | **DRM**（Widevine / FairPlay / PlayReady） | 无法播放 | 正版流媒体（奈飞、爱优腾的会员片源等） |

1–6 都是**“缺少浏览器上下文”**的问题：浏览器能播是因为它带着 Cookie、Referer、能跑 JS、能处理 CORS 和容错；电视没有这些。7 是法律和技术上都不能绕过的版权保护，AnyCast **明确不支持**，会直接提示用户使用官方 App 投屏。

## 2. 思路

> **在浏览器里拿到真实视频地址 + 当时的请求上下文，再让一个局域网“网关”替电视去拉流。**

- **嗅探层（手机端）**：浏览器扩展 / 书签脚本，在网页里拦截播放器的网络请求，得到 m3u8/mpd/mp4 的真实地址以及浏览器发送时带的 Referer、Cookie、UA、Authorization 等请求头。
- **网关层（局域网）**：一个零依赖的 Node.js 服务，负责：
  - 发现电视（SSDP → DLNA，mDNS → Chromecast，以及电视浏览器接收端）；
  - **中继代理（relay）**：电视只访问网关，网关用浏览器的上下文去请求源站，并把 m3u8/mpd 里的每一个地址改写成网关地址，顺便加上 CORS 头、修正 Content-Type、剥掉伪装切片的图片头；
  - **转封装（可选，ffmpeg）**：把 DASH、音视频分离、FLV 等格式实时 remux 成一条 MPEG-TS 流（只复制不重编码，树莓派也能跑）；
  - 控制电视播放（DLNA AVTransport / Cast V2 协议）。
- **决策**：每次投屏自动选择代价最小、又一定能播的方式：**直连 → 代理 → 转封装**。

## 3. 架构

```
           手机                                   局域网                               电视
┌──────────────────────────┐          ┌─────────────────────────────────┐        ┌──────────────────┐
│ 任意视频网页              │          │ AnyCast 网关 (Node.js, :8090)    │        │ DLNA 渲染器       │
│  ├ 扩展 sniffer.js       │  POST    │  ├ /api        REST API          │  SOAP  │ (几乎所有智能电视) │
│  │  (fetch/XHR/MSE/EME)  │ /api/cast│  ├ discovery   SSDP + mDNS       │──────▶ ├──────────────────┤
│  ├ 扩展 background.js    │ ───────▶ │  ├ renderers   DLNA/Cast/Web     │ CASTV2 │ Chromecast /     │
│  │  (webRequest+请求头)   │          │  ├ cast.js     直连/代理/转封装决策│──────▶ │ Google TV        │
│  └ 或 书签脚本 / 粘贴链接 │          │  ├ /r  relay   带上下文中继+改写   │ ◀───── ├──────────────────┤
│                          │          │  ├ /t  ffmpeg  remux → MPEG-TS   │  HTTP  │ 电视浏览器 /tv    │
│ 手机遥控页 (网关提供)      │ ◀──────▶ │  └ /tv         电视浏览器接收端    │  拉流  │ (SSE + hls.js)   │
└──────────────────────────┘          └───────────────┬─────────────────┘        └──────────────────┘
                                                      │ 带 Referer/Cookie/UA 请求
                                                      ▼
                                              视频网站 CDN / 源站
```

网关可以跑在：家里的电脑 / NAS / 树莓派 / 软路由，或手机本身（安卓 Termux）。见 §9 关于原生 App 的演进。

## 4. 组件

### 4.1 浏览器扩展（`extension/`）

Manifest V3，一套代码覆盖：Firefox 安卓、Edge 安卓、Kiwi 系浏览器、Safari iOS/macOS（Xcode 转换）、电脑上的 Chrome/Edge/Firefox。

| 文件 | 作用 |
|------|------|
| `sniffer.js` | 以 `world: "MAIN"` 在页面 JS 环境 `document_start` 注入（不支持 MAIN world 的浏览器由 `content.js` 回退注入）。Hook `fetch`、`XMLHttpRequest`（按 URL 和响应 Content-Type / `#EXTM3U` 内容识别）、`URL.createObjectURL(MediaSource)`（标记 MSE）、`navigator.requestMediaKeySystemAccess`（标记 DRM）、`HTMLMediaElement.src` setter、`play` 事件。 |
| `background.js` | `webRequest.onBeforeSendHeaders`（Chrome 加 `extraHeaders`）记录**真实请求头**；`onHeadersReceived` 按 URL + Content-Type 识别 HLS/DASH/视频文件，排除切片/图片；按标签页聚合、排序（HLS master > HLS > DASH > MP4，降权广告和小文件），角标显示数量；MV3 Service Worker 被回收时用 `storage.session` 恢复。 |
| `content.js` | 页面 ↔ 后台桥接；在顶层页面显示悬浮“📺 投屏 (n)”按钮（移动端扩展菜单藏得很深，悬浮按钮是主要入口），点击后在新标签页打开投屏面板。 |
| `popup.*` | 投屏面板：视频列表、电视列表、投屏方式、简易遥控。投屏时通过 `cookies.getAll` 补齐 **HttpOnly 登录 Cookie**（页面脚本读不到）。抓不到时可“交给网关深度解析”。 |

### 4.2 书签脚本（`gateway/public/bookmarklet.js`）

给不能装扩展的浏览器（iOS Safari、安卓 Chrome）用。它在点击时运行，无法回溯 hook 网络，所以改为收集：

- `performance.getEntriesByType('resource')`：页面已经请求过的所有 URL，**MSE 播放器拉过的 m3u8 就在这里**；
- `<video>/<source>` 地址、同源 iframe（递归）、HTML/内联脚本中的流地址；
- 跨域 iframe 地址（交给网关服务端解析）；
- `document.cookie`、UA、标题；`video.mediaKeys` 非空则提示 DRM。

**关键细节**：HTTPS 网页里 `fetch('http://192.168.x.x')` 会被混合内容策略拦截，所以书签脚本不直接调网关，而是弹出一个底部卡片，用户点按钮后**顶层跳转**到 `http://网关/#p=<base64url(JSON)>`（顶层导航不受混合内容限制；数据放在 URL fragment 中，不会出现在任何请求日志里）。网关页面读取后立即从地址栏清除。

### 4.3 网关（`gateway/`）

零运行时依赖（Node ≥ 20 内置模块），可选增强：`ffmpeg`（转封装）、`yt-dlp`（站点专用解析器）、`playwright`（无头浏览器嗅探）。

| 模块 | 说明 |
|------|------|
| `discovery/ssdp.js` | 每个网卡发送 `M-SEARCH`（ST=MediaRenderer），同时监听 1900 端口的 NOTIFY/byebye；支持单播 SSDP 目标（容器/VPN 无组播时）。 |
| `discovery/mdns.js` | 手写 DNS 报文编解码（含名称压缩），从临时端口发 legacy-unicast 查询 `_googlecast._tcp.local`，不与系统 avahi/Bonjour 抢 5353。 |
| `renderers/dlna.js` | 解析设备描述（URLBase、相对 controlURL），SOAP 调用 `SetAVTransportURI`（带 DIDL-Lite 元数据、DLNA.ORG_OP/FLAGS）、`Play/Pause/Stop/Seek`、`GetPositionInfo`、`RenderingControl.SetVolume`；`ConnectionManager.GetProtocolInfo` 读取电视声明支持的 MIME，用于决策。兼容处理：电视忙时先 `Stop` 再设置、元数据被拒时退回空元数据、`Play` 返回 701 时重试。 |
| `renderers/chromecast.js` | 手写 CASTV2（TLS + 长度前缀 protobuf `CastMessage`），心跳、启动 Default Media Receiver（`CC1AD845`）、`LOAD`/`PLAY`/`PAUSE`/`SEEK`/`SET_VOLUME`/`GET_STATUS`。 |
| `renderers/web.js` | 电视浏览器接收端：电视打开 `http://网关/tv`，通过 SSE 接收指令、POST 回报状态；页面按需从 CDN 加载 hls.js / dash.js。覆盖没有 DLNA、或 DLNA 播放器不支持 HLS 的电视。 |
| `proxy/relay.js` | 核心中继，见 §5。 |
| `proxy/hls.js` / `proxy/dash.js` | 播放列表 / MPD 改写（纯函数，单元测试覆盖）。 |
| `extract/` | 服务端解析流水线，见 §6。 |
| `cast.js` | 归一化媒体描述、探测、DRM 拦截、直连/代理/转封装决策、会话与遥控。 |
| `transcode.js` | `ffmpeg -c copy -f mpegts`，输入走本地 relay（因此仍带浏览器上下文）；两路输入时 `-map 0:v -map 1:a` 合并音视频；输出不用 chunked 编码（部分电视不兼容）；拖动进度时以 `-ss` 重启。 |
| `public/` | 手机遥控页、电视接收端、书签脚本模板。 |

## 5. 中继代理（relay）细节

URL 刻意做短（部分电视对 URL 长度敏感）：

```
/r/<sourceId>/<n>/<文件名>        → 某个具体的上游 URL（第 n 个登记项）
/r/<sourceId>/d<n>/<相对路径>     → 某个上游目录下的任意路径（DASH 模板生成的地址）
```

- **只中继登记过的地址**：主地址 + 从它的播放列表里解析出来的地址（不是开放代理）；DASH 目录映射会校验解析后的地址不能逃出该目录（`..` 攻击）。
- **请求**：回放 `Referer / Origin / Cookie / User-Agent / Authorization / X-*`；转发电视的 `Range`；`Accept-Encoding: identity`（保证 Content-Length 准确）；跨域重定向时丢弃 Cookie/Authorization（与浏览器一致）。
- **HLS 改写**：master 与 media playlist、`EXT-X-KEY`（AES-128 密钥）、`EXT-X-MAP`、`EXT-X-MEDIA`、`EXT-X-I-FRAME-STREAM-INF`、`EXT-X-PART`、`EXT-X-PRELOAD-HINT`、`EXT-X-RENDITION-REPORT`；按重定向后的最终地址解析相对路径；保留 `.m3u8` / `.ts` 文件名（有的电视按扩展名判断格式）；`skd://`（FairPlay）不改写。
- **DASH 改写**：插入/改写 MPD 级 `BaseURL` 为目录映射；绝对地址的 `BaseURL`、`media`、`initialization` 同样映射；模板（`$Number$` 等）保持不变。
- **`Range: bytes=0-`**（ffmpeg 和很多电视默认发送）对清单和切片按完整请求处理，以便改写。
- **伪装切片**：切片以 PNG/JPEG/GIF/BMP/WebP 签名开头、且其后找到连续 3 个间隔 188 字节的 `0x47` 同步字节时，剥掉前缀，修正 Content-Length 和 Content-Type。
- **响应头**：`Access-Control-Allow-Origin: *`（Chromecast / 电视浏览器需要）、修正通用 Content-Type（`application/octet-stream`、`image/png` → 按扩展名/内容推断）、`transferMode.dlna.org`、按需返回 `contentFeatures.dlna.org`、透传 `Content-Range/Accept-Ranges/ETag`。

## 6. 视频地址获取流水线

优先级从“最可靠”到“最重”：

1. **客户端候选**（扩展 / 书签脚本）——来自真实页面，用页面上下文逐个探测，丢弃失效的；
2. **地址本身就是媒体**（用户直接粘贴了 m3u8/mp4）；
3. **静态 HTML**：`<video>/<source>`、`og:video`、JSON-LD `contentUrl`、内联脚本里转义过的地址（`\/`、`/`）、并跟进一层 iframe 嵌入页（Referer 设为外层页面）；
4. **yt-dlp**（若安装）：上千个站点的专用解析器，支持音视频分离格式；
5. **无头 Chromium**（若安装 Playwright）：加载页面、尝试点播放、记录媒体请求和**实际发送的请求头**。

所有候选都会带上下文做一次探测：确认类型（嗅探 `#EXTM3U`、`<MPD`、`ftyp`、TS 同步字节、EBML）、识别 DRM（Widevine/PlayReady/FairPlay 的 KEYFORMAT / ContentProtection）、直播/点播、master/变体，然后排序。

## 7. 投屏决策算法（`cast.js`）

```
normalize(media):  用浏览器上下文探测 → 不可达: 报“链接可能已过期，请回到网页重新播放”
                                     → 检出 DRM: 拒绝并提示用官方 App
plan(media, device, mode=auto):
  若音视频分离                     → 转封装（需要 ffmpeg）
  若 DLNA 电视声明不支持该 MIME，
     或 DLNA + DASH（未声明支持），
     或 FLV/AVI                    → 转封装（有 ffmpeg 时）
  needCors = 设备是 Chromecast/电视浏览器 且 是 HLS/DASH
  probeDirect(不带任何 Cookie/Referer，模拟电视；needCors 时要求 ACAO 头；
              HLS 会继续探测变体、密钥、首个切片，切片是伪装图片也算失败)
     成功 → 直连（网关不承担流量）
     失败 → 代理
```

用户也可以手动指定“直连 / 代理 / 转封装”。

## 8. 安全、隐私与合规

- **不破解 DRM**。检测到 Widevine / PlayReady / FairPlay / CENC 立即拒绝，提示使用官方投屏。AnyCast 只是让电视以“和你的浏览器相同的身份”播放你本来就能在这台手机上播放的内容，等价于把浏览器的播放器搬到电视上。
- **Cookie 只在局域网内流动**：扩展 → 网关（局域网 HTTP），书签脚本数据放在 URL fragment；网关只在内存中保存，会话结束（停止投屏或 6 小时闲置）即删除。
- **网关默认信任局域网**。共享网络（宿舍、公司）请用 `--token` 启用访问令牌；relay 只代理登记过的地址，不是开放代理。
- 网关不需要也不会访问除视频源站之外的任何外部服务；电视浏览器接收端仅在电视不支持原生 HLS/DASH 时从 jsDelivr 加载固定版本的 hls.js / dash.js。

## 9. 平台与产品形态演进

| 阶段 | 形态 | 说明 |
|------|------|------|
| **v0.1（本仓库）** | 局域网网关 + 扩展 + 书签脚本 + 手机网页遥控 | 不需要上架任何应用商店，所有平台立刻可用；需要一台常开设备（或安卓 Termux）。 |
| v0.2 | 安卓 App：内置浏览器（WebView）+ 内嵌网关 | WebView `shouldInterceptRequest` 天然拿到全部请求和请求头；网关逻辑用 Kotlin 移植（NanoHTTPD/Ktor 做 relay，Cling/jUPnP 或自写 SSDP/SOAP，Cast 用官方 Sender SDK）；注册为系统“分享”目标（`ACTION_SEND`），从任何 App 分享链接即可投屏；前台服务保证投屏期间不被杀。 |
| v0.3 | iOS App：Safari Web Extension（复用 `extension/`）+ App 内中继 | iOS 后台限制严格：代理模式需要 App 前台或使用后台音频会话；AirPlay 可直接用 `AVPlayer` + 中继地址（系统负责 AirPlay 2 配对）；DLNA 同安卓。 |
| v0.4 | 电视端 App（Android TV / Google TV / 国内电视应用市场） | 作为接收端替代 DLNA：内置 ExoPlayer，可直接接收“地址 + 请求头”，在大多数情况下不再需要中继；支持弹幕、倍速等。 |

为什么第一版选“网关”而不是直接做 App：网关在**任何手机、任何浏览器**上都能立刻验证全部核心技术（嗅探、上下文中继、清单改写、DLNA/Cast 控制、转封装），这些逻辑后续原样移植进 App。

## 10. 已知限制

- DRM 内容不支持（设计如此）。
- 链接有效期很短、或 CDN 把签名绑定到手机 IP + 网关在另一个出口 IP 时，代理模式可能失败（同一个家庭网络通常是同一出口 IP）。
- 通过 WebSocket / WebRTC / 自定义加密协议（非标准 HLS AES-128）传输的视频无法处理。
- 转封装模式不能按字节拖动，进度跳转通过重启 ffmpeg 实现，会有 1–2 秒缓冲。
- 书签脚本拿不到 HttpOnly Cookie；需要登录的网站推荐用扩展。
- AirPlay（Apple TV）未实现：AirPlay 2 需要配对认证，计划在 iOS App 中通过系统 `AVPlayer` 实现；搭载“乐播投屏”的国产电视同时支持 DLNA，已可使用。

## 11. 测试

`npm test`（50 个用例，约 2 秒）+ `npm run test:browser`（4 个 Playwright 用例），全部本地运行，不依赖真实电视：

- `test/fixtures/origin.js`：模拟一个“难投屏”的视频网站——Referer+Cookie 防盗链、相对路径、AES-128、伪装成 PNG 的 TS 切片、DASH 模板、FairPlay DRM、需要从脚本/iframe 中提取地址的页面、MSE 播放页、EME 页面；
- `tools/fake-dlna-tv.js`：模拟 DLNA 电视（SSDP 应答、设备描述、AVTransport/RenderingControl/ConnectionManager），收到 `Play` 后像真实电视一样**不带任何 Cookie/Referer** 去拉流并校验内容；
- `test/fixtures/fake-chromecast.js`：TLS + CASTV2 的模拟 Chromecast，拉清单时带 `Origin` 检查 CORS；
- 端到端用例证明：**直接把地址交给电视会 403 失败，经 AnyCast 中继后电视正常播放**；开放 CDN 自动直连；DRM 被拒绝；ffmpeg 将真实 HLS、以及分离的音视频合成为一条 TS 流（ffprobe 验证同时含音视频轨）；
- 浏览器用例：页面嗅探器识别 MSE 与 EME；书签脚本 → 手机遥控页 → 电视播放的完整用户流程；**真实加载扩展**，从网页捕获流和请求头并投屏成功。
