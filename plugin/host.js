// dsh-voice-input — 宿主端（Host half）
// 作为 DeepSeek Harness 动态 Cordis 插件的 host 代码使用。
// 职责：接收客户端发来的 Opus 包（base64），调用纯 Node 助手 asr_helper.mjs，
// 返回豆包零配置 ASR 的识别文本。
//
// 使用前请把 HELPER 与 CACHE_DIR 改成你机器上的实际路径。
return {
  inject: ['timer'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return
    const helper = '/home/tiger/Documents/dsh-voice-input/asr_helper.mjs'
    const cacheDir = '/home/tiger/.cache/dsh-voice'
    let nodePath = null
    let busy = false

    harness.handle('transcribe', async (args) => {
      if (busy) return { ok: false, error: '上一次语音识别尚未完成' }
      const packets = args && Array.isArray(args.packets) ? args.packets : []
      if (!packets.length) return { ok: false, error: 'packets 为空' }
      busy = true
      try {
        if (nodePath === null) {
          try {
            nodePath = await subprocess.resolveExecutable('node')
          } catch (e) {
            nodePath = await subprocess.resolveExecutable('/home/tiger/.nvm/versions/node/v24.19.0/bin/node')
          }
        }
        const handle = subprocess.spawn({
          argv: [nodePath, helper],
          cwd: '/home/tiger',
          stdio: {
            stdin: { data: JSON.stringify({ packets, cache_dir: cacheDir }) },
            stdout: { maxBytes: 1 << 20 },
            stderr: { maxBytes: 1 << 20 },
          },
          graceMs: 30000,
        })
        const cancelTimeout = ctx.timeout(() => handle.terminate(), 90000)
        await handle.done
        cancelTimeout()
        const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text.trim() : ''
        const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text.trim() : ''
        if (!stdout) {
          return { ok: false, error: 'ASR 助手无输出' + (stderr ? '：' + stderr.slice(0, 200) : '') }
        }
        try {
          return JSON.parse(stdout)
        } catch (e) {
          return { ok: false, error: 'ASR 助手输出异常：' + stdout.slice(0, 200) }
        }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e).slice(0, 400) }
      } finally {
        busy = false
      }
    })
  },
}
