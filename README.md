# dsh-voice-input

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 加一个**手机端语音输入**插件：点一下输入框旁的麦克风，说话，再点一下，语音自动识别成文字写进输入框——手机上再也不用打字了。

语音识别使用**豆包输入法零配置 ASR**（无需注册、无需 API Key），协议实现参考 [yangmoling/doubaoime-asr](https://github.com/yangmoling/doubaoime-asr) 与 [day253/typeless-ibus](https://github.com/day253/typeless-ibus) 的 doubao provider。

## 效果

- 输入框工具行右侧（发送键旁）出现一个 🎤 按钮
- 点击开始录音（按钮变红脉冲），再点一次结束
- 自动识别（按钮变转圈），识别文本直接写入输入框草稿
- 出错时按钮上方弹出红色提示，点击可关闭

## 架构

```
手机浏览器                               宿主进程（DSH Host）
┌──────────────────────────┐            ┌──────────────────────────────┐
│ 麦克风按钮（Client 插件） │            │ host.call('transcribe')      │
│  MediaRecorder           │            │  → spawn node asr_helper.mjs │
│  → webm/ogg (Opus)       │  base64    │    ├ 注册设备 (snssdk)       │
│  → 容器解析提取 Opus 包  │ ──────────► │    ├ 取 app_key (settings)  │
│  → setDraft(识别文本) ◄─ │   JSON     │    └ WebSocket 流式 ASR      │
└──────────────────────────┘            │      (frontier-audio-ime-ws) │
                                        └──────────────────────────────┘
```

**为什么纯 Node、零依赖**：服务端不做 Opus 编码——浏览器的 `MediaRecorder` 产出的本来就是
Opus 编码的 webm/ogg，客户端只需把 Opus 包从容器里提取出来原样转发。剩下的注册/取 token/
WebSocket/protobuf 全部用 Node ≥ 22 内置的 `fetch`、全局 `WebSocket`（支持自定义 headers）、
`crypto` 实现，不需要任何 npm 包。

## 目录结构

```
.
├── asr_helper.mjs        # 纯 Node 助手：豆包零配置 ASR 客户端（stdin JSON → stdout JSON）
├── plugin/
│   ├── host.js           # DSH 动态插件 Host half（transcribe RPC）
│   └── client.js         # DSH 动态插件 Client half（麦克风按钮 + Opus 提取）
├── test/smoke.mjs        # 端到端冒烟测试（wav → webm → 提取 Opus → ASR）
└── README.md
```

## 安装到 DeepSeek Harness

### 1. 前置条件

- 本机可运行 `node`（≥ 22，DSH 自带的即可）
- 打开 GUI 的域名是 **HTTPS**（浏览器麦克风要求；经 Cloudflare Tunnel 访问天然满足）
- 手机浏览器：Chrome / Edge / Firefox（iOS Safari 的 MediaRecorder 只出 AAC，不支持，请用系统听写）

### 2. 部署助手

```bash
git clone https://github.com/day253/dsh-voice-input.git
```

修改 `plugin/host.js` 里的 `helper` 与 `cache_dir` 路径指向你的实际位置。

### 3. 加载插件

把 `plugin/host.js` 的内容作为 Host 代码、`plugin/client.js` 的内容作为 Client 代码，
在 DSH 里定义一个动态 Cordis 插件并运行（本仓库开发时即以此方式部署）。

> 动态插件在 DSH 进程重启后会失效；想永久安装，可把这两段代码做成 DSH 组合
> （composition）里的 host 行 + `dsh.client` 行，或做成 npm 包后在 bundle patch 里挂载。

### 4. 使用

手机浏览器打开你的 GUI 域名 → 输入框右侧点 🎤 → 说话 → 再点一下 🎤 → 等待转圈结束，
文字自动出现在输入框里。

## 冒烟测试（无浏览器验证整条链路）

```bash
# 需要一个带语音的 wav（这里用 whisper.cpp 的 JFK 样例）
curl -sSL -o /tmp/jfk.wav \
  https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav
pip install imageio-ffmpeg   # 仅为测试提供 ffmpeg
node test/smoke.mjs /tmp/jfk.wav "$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
```

预期输出：

```
[2] 共 550 个 opus 包（约 11.0s 音频）
[3] exit 0: {"ok":true,"text":"And so my fellow Americans, ask not ..."}
```

## 凭据与隐私

- 首次识别会自动注册一个虚拟设备并获取短期凭据，缓存在 `~/.cache/dsh-voice/credentials.json`
- **不要**把 `credentials.json` 提交到 Git 或复制到其他机器
- 语音会发送到字节跳动的语音服务；本插件不做任何留存

## 免责声明

豆包输入法 ASR 协议是**非官方、不公开、不保证稳定**的接口，参考了
[yangmoling/doubaoime-asr](https://github.com/yangmoling/doubaoime-asr)
（安卓客户端协议分析）与
[day253/typeless-ibus](https://github.com/day253/typeless-ibus)
的 doubao provider 实现。服务端行为可能随时变化导致失效，仅供学习研究使用。

## License

MIT
