# AnyCast · 网页视频投屏

在手机上打开**任何网站**的视频，一键投到同一 Wi-Fi 下的智能电视。

浏览器自带的投屏只是把视频地址交给电视，而电视的播放器不带 Cookie、不带 Referer、不处理跨域，所以大量网站的视频投不上去。AnyCast 在手机浏览器里抓到**真实视频地址和当时的请求上下文**，再由局域网里的网关替电视拉流、改写播放列表、必要时转封装。详细分析见 [docs/DESIGN.md](docs/DESIGN.md)。

| 能解决 | 怎么解决 |
|--------|---------|
| 网页用 MSE/hls.js 播放，浏览器不出现投屏按钮 | 扩展 hook 播放器请求 / 书签脚本读取已请求资源，拿到 m3u8/mpd |
| 防盗链（Referer、Cookie、token 头）→ 电视 403 | 网关中继，回放浏览器的请求头，并改写播放列表里的每个地址 |
| Chromecast 跨域失败 | 中继统一加 `Access-Control-Allow-Origin: *` |
| DASH、音视频分离、FLV，老电视不支持 | ffmpeg 实时转封装为 MPEG-TS（只复制不重编码） |
| TS 切片伪装成 PNG | 中继自动剥离假图片头 |
| 电视没有 DLNA | 电视浏览器打开 `http://网关:8090/tv` 作为接收端 |
| **DRM 版权保护视频** | **不支持**，会明确提示使用官方 App 投屏 |

支持的电视：DLNA/UPnP 渲染器（三星、LG、索尼、海信、TCL、小米、创维等，以及内置乐播投屏的设备）、Chromecast / Google TV、任何带浏览器的电视。

## 快速开始

### 1. 运行网关

在家里任意一台常开的设备上（电脑、NAS、树莓派、软路由，或安卓手机的 Termux），需要 Node.js ≥ 20：

```bash
git clone https://github.com/dn3point/AnyCast.git
```

```bash
cd AnyCast && npm start
```

启动后会打印访问地址，例如 `http://192.168.1.10:8090`。网关没有任何 npm 依赖。可选增强：

- `ffmpeg`：转封装（音视频分离、DASH、老电视）
- `yt-dlp`：上千个网站的专用解析器
- `playwright`：无头浏览器深度解析（`npm i playwright`）

常用参数：`--port 8090`、`--token <口令>`（共享网络时开启访问令牌）、`--advertise <ip>`（多网卡时指定电视访问网关用的 IP），`npm start -- --help` 查看全部。

### 2. 在手机上投屏（三选一）

1. **浏览器扩展**（推荐，Firefox 安卓 / Edge 安卓 / Safari iOS / 电脑浏览器）：安装 [`extension/`](extension/README.md)，在设置里填网关地址。看视频时网页右下角出现“📺 投屏”按钮。
2. **书签脚本**（所有手机浏览器）：手机打开网关地址，按页面底部说明把“投屏”书签脚本加入书签；看视频时点它。
3. **粘贴链接**：手机打开网关地址，粘贴网页链接，网关解析后投屏。

投屏后可以在手机上暂停、拖动进度、调音量、停止。

### 没有电视也能试

```bash
npm run fake-tv
```

会在局域网里模拟一台 DLNA 电视（像真电视一样不带 Cookie/Referer 拉流），投屏结果打印在终端。

## 开发

```bash
npm test
```

```bash
npm run test:browser
```

- `npm test`：50 个单元 + 端到端用例（模拟防盗链网站、模拟 DLNA 电视、模拟 Chromecast、真实 ffmpeg 转封装）。
- `npm run test:browser`：Playwright + Chromium，测试页面嗅探、书签脚本完整流程、真实加载扩展投屏。

```
gateway/
  bin/anycast.js          命令行入口
  src/server.js           HTTP 服务：/api、/r（中继）、/t（转封装）、/tv
  src/cast.js             直连 / 代理 / 转封装 决策与会话
  src/proxy/              中继、HLS/DASH 改写
  src/renderers/          DLNA、Chromecast、电视浏览器接收端
  src/discovery/          SSDP、mDNS
  src/extract/            视频地址解析流水线（HTML / yt-dlp / 无头浏览器）
  public/                 手机遥控页、电视接收端、书签脚本
  tools/fake-dlna-tv.js   模拟电视
extension/                浏览器扩展（MV3）
docs/DESIGN.md            设计文档
```

## 许可

MIT
