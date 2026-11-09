#!/usr/bin/env node
'use strict';

const { createGateway } = require('../src/server');
const log = require('../src/util/log');
const { ffmpegAvailable } = require('../src/transcode');
const tools = require('../src/extract/tools');
const { ipv4Interfaces } = require('../src/discovery/ssdp');

const HELP = `AnyCast 网关 —— 把手机网页里的视频投到局域网电视

用法: anycast [选项]

  -p, --port <n>          监听端口（默认 8090，或环境变量 ANYCAST_PORT）
      --host <ip>         监听地址（默认 0.0.0.0）
      --advertise <ip>    告诉电视用哪个 IP 访问网关（默认自动按子网匹配）
      --token <secret>    为 /api 启用访问令牌（或 ANYCAST_TOKEN）
      --no-discovery      关闭 SSDP / mDNS 自动发现
      --ssdp-target <h:p> 额外的单播 SSDP 目标（容器 / VPN 中没有组播时使用，可重复）
      --log <level>       debug | info | warn | error
  -h, --help              显示帮助
`;

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.ANYCAST_PORT || 8090),
    token: process.env.ANYCAST_TOKEN || null,
    ssdpTargets: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-p':
      case '--port':
        opts.port = Number(next());
        break;
      case '--host':
        opts.host = next();
        break;
      case '--advertise':
        opts.advertiseHost = next();
        break;
      case '--token':
        opts.token = next();
        break;
      case '--no-discovery':
        opts.discovery = false;
        break;
      case '--ssdp-target':
        opts.ssdpTargets.push(next());
        break;
      case '--log':
        log.setLevel(next());
        break;
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        process.stderr.write(`未知参数: ${a}\n\n${HELP}`);
        process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gw = createGateway(opts);
  await gw.listen(opts.host);
  const addresses = ipv4Interfaces().map((a) => a.address);
  const urls = (addresses.length ? addresses : ['127.0.0.1']).map((a) => `http://${a}:${gw.port}`);
  console.log('\n  AnyCast 网关已启动');
  console.log(`  手机打开:      ${urls[0]}`);
  for (const u of urls.slice(1)) console.log(`                 ${u}`);
  console.log(`  电视浏览器接收端: ${urls[0]}/tv`);
  console.log(
    `  可选组件:      ffmpeg ${ffmpegAvailable() ? '✓' : '✗'}  yt-dlp ${tools.ytdlpAvailable() ? '✓' : '✗'}  headless ${tools.headlessAvailable() ? '✓' : '✗'}`,
  );
  if (opts.token) console.log('  已启用访问令牌');
  console.log('');

  const shutdown = async () => {
    await gw.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
