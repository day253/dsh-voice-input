// 测试用共享执行器：按宿主端同样的行协议驱动 asr_helper.mjs 跑一次流式识别。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, '..', 'asr_helper.mjs')

export function streamAsr({ packets, cacheDir, batchMs = 300, onInterim = null, finishDelayMs = 2500 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, cacheDir], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    const events = []
    const interims = []
    let bufout = ''
    const waiters = []
    child.stdout.on('data', (c) => {
      bufout += c.toString()
      let idx
      while ((idx = bufout.indexOf('\n')) >= 0) {
        const line = bufout.slice(0, idx).trim()
        bufout = bufout.slice(idx + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.type === 'interim') interims.push(m.text)
        events.push(m)
        const w = waiters.shift()
        if (w) w(m)
      }
    })
    const nextEvent = (types, timeoutMs) => new Promise((res, rej) => {
      const idx = events.findIndex((m) => types.includes(m.type))
      if (idx >= 0) return res(events.splice(idx, 1)[0])
      const timer = setTimeout(() => rej(new Error(`等待 ${types.join('/')} 超时`)), timeoutMs)
      waiters.push((m) => {
        clearTimeout(timer)
        const i = events.findIndex((e) => e === m)
        if (i >= 0) events.splice(i, 1)
        res(m)
      })
    })
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    const run = async () => {
      try {
        send({ type: 'start' })
        await nextEvent(['ready', 'error'], 90000)
        const batchSize = Math.max(1, Math.ceil(packets.length / Math.ceil(packets.length * batchMs / 8000)))
        const started = Date.now()
        for (let i = 0; i < packets.length; i += batchSize) {
          const batch = packets.slice(i, i + batchSize)
          send({ type: 'packets', packets: batch.map((p) => Buffer.from(p).toString('base64')) })
          // 尽可能快地排空事件，让 interim 及时送达
          await sleep(batchMs)
        }
        const waitUntil = started + (packets.length / 50) * batchMs + finishDelayMs
        const remain = Math.max(0, waitUntil - Date.now())
        if (remain > 0) await sleep(remain)
        send({ type: 'finish' })
        let final = ''
        let done = false
        let error = null
        const deadline = Date.now() + 90000
        while (Date.now() < deadline) {
          let m
          try { m = await nextEvent(['interim', 'final', 'done', 'error'], 10000) } catch { break }
          if (m.type === 'final') final = m.text
          if (m.type === 'error') { error = m.error; break }
          if (m.type === 'done') { done = true; break }
        }
        child.kill()
        if (error) resolve({ ok: false, error, interims, stderr })
        else if (!done) resolve({ ok: false, error: '未收到 done', interims, stderr })
        else resolve({ ok: true, final, interims, stderr })
      } catch (e) {
        child.kill()
        resolve({ ok: false, error: String(e?.message || e), interims, stderr })
      }
    }
    run()
  })
}
