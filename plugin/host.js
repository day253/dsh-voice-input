// dsh-voice-input — 宿主端（Host half）
// 作为 DeepSeek Harness 动态 Cordis 插件的 host 代码使用。
// 职责：维护一个长驻的 Node 助手子进程（asr_helper.mjs，行协议），
// 提供三个 Package 私有 RPC：
//   asrStart           开启一次流式 ASR 会话（点击麦克风即调用）
//   asrChunk  {packets} 追加 Opus 包（实时发送，立即返回最新中间文本）
//   asrFinish {packets} 结束会话（标记 LAST + FinishSession，返回最终文本）
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

    let child = null
    let lineBuf = ''
    const queue = []       // 已解析的助手事件
    const pending = []     // 等待中的 waiter {types, resolve, reject, cancel}
    let lastInterim = ''
    let lastFinal = ''
    let failed = null

    function notify() {
      for (let i = 0; i < pending.length; i++) {
        const w = pending[i]
        const idx = queue.findIndex((m) => w.types.indexOf(m.type) >= 0)
        if (idx >= 0) {
          const msg = queue.splice(idx, 1)[0]
          pending.splice(i, 1)
          w.cancel()
          w.resolve(msg)
          i--
        }
      }
    }

    function pushLine(line) {
      let msg
      try { msg = JSON.parse(line) } catch (e) { return }
      if (msg.type === 'interim') lastInterim = msg.text || ''
      if (msg.type === 'final') lastFinal = msg.text || ''
      if (msg.type === 'error') failed = msg.error || 'ASR 出错'
      queue.push(msg)
      notify()
    }

    function killChild() {
      if (child) {
        try { child.terminate() } catch (e) {}
        child = null
      }
      while (pending.length) {
        const w = pending.shift()
        w.cancel()
        w.reject(new Error('ASR 进程已终止'))
      }
    }

    function waitEvent(types, timeoutMs) {
      return new Promise((resolve, reject) => {
        const waiter = { types, resolve, reject, cancel: null }
        waiter.cancel = ctx.timeout(() => {
          const i = pending.indexOf(waiter)
          if (i >= 0) pending.splice(i, 1)
          reject(new Error('ASR 等待超时'))
        }, timeoutMs)
        pending.push(waiter)
        notify()
      })
    }

    async function resolveNode() {
      if (nodePath !== null) return nodePath
      try {
        nodePath = await subprocess.resolveExecutable('node')
      } catch (e) {
        nodePath = await subprocess.resolveExecutable('/home/tiger/.nvm/versions/node/v24.19.0/bin/node')
      }
      return nodePath
    }

    function spawnHelper() {
      return subprocess.spawn({
        argv: [nodePath, helper, cacheDir],
        cwd: '/home/tiger',
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 15000,
      })
    }

    ctx.effect(() => () => killChild(), 'dsh-voice-input: helper cleanup')

    harness.handle('asrStart', async () => {
      if (child) return { ok: true }
      lastInterim = ''
      lastFinal = ''
      failed = null
      queue.length = 0
      try {
        await resolveNode()
        child = spawnHelper()
        const dec = new TextDecoder()
        child.stdout.on('data', (chunk) => {
          lineBuf += dec.decode(chunk)
          let idx
          while ((idx = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, idx).trim()
            lineBuf = lineBuf.slice(idx + 1)
            if (line) pushLine(line)
          }
        })
        child.stderr.on('data', () => {}) // 忽略噪音，诊断时可开启
        child.stdin.write(JSON.stringify({ type: 'start' }) + '\n')
        const msg = await waitEvent(['ready', 'error'], 90000)
        if (msg.type === 'error') {
          const err = msg.error || 'ASR 启动失败'
          killChild()
          return { ok: false, error: err }
        }
        return { ok: true }
      } catch (e) {
        killChild()
        return { ok: false, error: String((e && e.message) || e).slice(0, 300) }
      }
    })

    harness.handle('asrChunk', async (args) => {
      if (!child) return { ok: false, error: '会话未开始' }
      if (failed) return { ok: false, error: failed, interim: lastInterim }
      const packets = args && Array.isArray(args.packets) ? args.packets : []
      if (packets.length) {
        try {
          child.stdin.write(JSON.stringify({ type: 'packets', packets }) + '\n')
        } catch (e) {
          return { ok: false, error: '写入 ASR 进程失败：' + String((e && e.message) || e) }
        }
      }
      return { ok: true, interim: lastInterim }
    })

    harness.handle('asrFinish', async (args) => {
      if (!child) return { ok: false, error: '会话未开始' }
      try {
        const packets = args && Array.isArray(args.packets) ? args.packets : []
        child.stdin.write(JSON.stringify({ type: 'finish', packets }) + '\n')
        const done = await waitEvent(['done', 'error'], 120000)
        const final = lastFinal || lastInterim || ''
        const err = done.type === 'error' ? done.error : null
        killChild()
        if (err) return { ok: false, error: err, final }
        return { ok: true, final, interim: lastInterim }
      } catch (e) {
        killChild()
        return { ok: false, error: String((e && e.message) || e).slice(0, 300) }
      }
    })
  },
}
