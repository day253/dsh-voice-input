#!/usr/bin/env node
/**
 * Chrome 真机浏览器链路测试（分段流式版，模拟客户端插件行为）：
 *   1. 用本机 Chrome（--use-fake-device-for-media-stream）真实录音
 *   2. 每 ~1.5s 一个录音段（各自是完整 webm），逐段提取 Opus 包（与 plugin/client.js 一致）
 *   3. 边录边交给流式 asr_helper.mjs，中间结果实时打印；停止后取最终文本
 *
 * 设 FAKE_AUDIO_FILE=<44.1kHz 16bit 立体声 wav> 可让 fake 麦克风播放真实语音，
 * 从而断言识别文本（已验证可识别 JFK 演讲）。
 *
 * Usage: node test/chrome.mjs [chrome-path]
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const chromePath = process.argv[2] || '/usr/bin/google-chrome'
const fakeAudioFile = process.env.FAKE_AUDIO_FILE || null // 可选：44.1kHz 16bit 立体声 wav
const SEGMENT_MS = 1500

// ---- 与 plugin/client.js 一致的 webm 解析 ----
function readVint(dv, pos) {
  const first = dv.getUint8(pos)
  let len = 1, mask = 0x80
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++ }
  let value = first & (mask - 1)
  for (let i = 1; i < len; i++) value = value * 256 + dv.getUint8(pos + i)
  return { value, len, id: value + mask * Math.pow(256, len - 1) }
}
function extractWebm(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 0
  const ebmlId = readVint(dv, pos); pos += ebmlId.len
  if (ebmlId.id !== 0x1A45DFA3) throw new Error('不是 WebM')
  const ebmlSize = readVint(dv, pos); pos += ebmlSize.len
  pos += ebmlSize.value
  const segId = readVint(dv, pos); pos += segId.len
  if (segId.id !== 0x18538067) throw new Error('缺少 Segment')
  const segSize = readVint(dv, pos); pos += segSize.len
  const segmentEnd = segSize.value === 0x0ffffffffffffff ? dv.byteLength : pos + segSize.value
  let audioTracks = null
  const packets = []
  while (pos < segmentEnd) {
    const id = readVint(dv, pos); pos += id.len
    const size = readVint(dv, pos); pos += size.len
    const next = pos + size.value
    if (id.id === 0x1654AE6B) {
      const tracks = []
      let p = pos
      while (p < next) {
        const tid = readVint(dv, p); p += tid.len
        const tsize = readVint(dv, p); p += tsize.len
        const tnext = p + tsize.value
        if (tid.id === 0xAE) {
          let trackNumber = 0, codecId = '', q = p
          while (q < tnext) {
            const cid = readVint(dv, q); q += cid.len
            const csize = readVint(dv, q); q += csize.len
            if (cid.id === 0xD7) { let v = 0; for (let i = 0; i < csize.value; i++) v = v * 256 + dv.getUint8(q + i); trackNumber = v }
            if (cid.id === 0x86) codecId = String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + q, csize.value))
            q += csize.value
          }
          if (codecId.startsWith('A_OPUS')) tracks.push(trackNumber)
        }
        p = tnext
      }
      audioTracks = tracks
    } else if (id.id === 0x1F43B675) {
      let p = pos
      while (p < next) {
        const cid = readVint(dv, p); p += cid.len
        const csize = readVint(dv, p); p += csize.len
        const cnext = p + csize.value
        if (cid.id === 0xA3 || cid.id === 0xA1) {
          const pl = new Uint8Array(dv.buffer, dv.byteOffset + p, csize.value)
          const pdv = new DataView(pl.buffer, pl.byteOffset, pl.byteLength)
          const t = readVint(pdv, 0)
          const flags = pdv.getUint8(t.len + 2)
          const lac = (flags >> 1) & 3
          const data = pl.subarray(t.len + 3)
          const push = (pkt) => { if (pkt.length && (!audioTracks || audioTracks.includes(t.value))) packets.push(pkt) }
          if (lac === 0) push(data)
          else if (lac === 2) {
            const count = data[0] + 1
            const body = data.subarray(1)
            const sz = Math.floor(body.length / count)
            for (let i = 0; i < count; i++) push(body.subarray(i * sz, (i + 1) * sz))
          }
        }
        p = cnext
      }
    }
    pos = next
  }
  return packets
}

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    ...(fakeAudioFile ? [`--use-file-for-fake-audio-capture=${fakeAudioFile}`] : []),
  ],
})

try {
  const page = await browser.newPage()
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })

  // 浏览器内：分段录音，产出每段的完整 webm（base64）
  const segments = await page.evaluate(async (segMs) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recordOne = () => new Promise((resolve) => {
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      const chunks = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      rec.onstop = async () => {
        const total = new Blob(chunks)
        const u = new Uint8Array(await total.arrayBuffer())
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
        let b64 = ''
        for (let i = 0; i < u.length; i += 3) {
          const b0 = u[i], b1 = i + 1 < u.length ? u[i + 1] : 0, b2 = i + 2 < u.length ? u[i + 2] : 0
          b64 += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)]
          b64 += i + 1 < u.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '='
          b64 += i + 2 < u.length ? chars[b2 & 63] : '='
        }
        resolve(b64)
      }
      rec.start()
      setTimeout(() => rec.stop(), segMs)
    })
    const out = []
    for (let i = 0; i < 3; i++) out.push(await recordOne()) // 3 段 ≈ 4.5s
    stream.getTracks().forEach((t) => t.stop())
    return out
  }, SEGMENT_MS)
  console.log(`[1] 真实 Chrome 分段录音: ${segments.length} 段，每段字节: ${segments.map((s) => Buffer.from(s, 'base64').length).join('/')}`)

  // 与客户端一致：逐段提取 Opus 包 → 流式发送
  console.log('[2] 流式 ASR（边录边识别）...')
  const { spawn } = await import('node:child_process')
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'asr_helper.mjs')
  const child = spawn(process.execPath, [helper, '/tmp/dsh-voice-test-cache-chrome'], { stdio: ['pipe', 'pipe', 'inherit'] })
  let bufout = ''
  const events = []
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
      events.push(m)
      const w = waiters.shift()
      if (w) w(m)
    }
  })
  const nextEvent = (types, timeoutMs) => new Promise((res, rej) => {
    const idx = events.findIndex((m) => types.includes(m.type))
    if (idx >= 0) return res(events.splice(idx, 1)[0])
    const timer = setTimeout(() => rej(new Error('等待超时')), timeoutMs)
    waiters.push((m) => { clearTimeout(timer); res(m) })
  })
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  send({ type: 'start' })
  await nextEvent(['ready', 'error'], 90000)
  console.log('[2] 会话就绪，逐段发送')
  const interims = []
  let totalPackets = 0
  for (const s of segments) {
    const packets = extractWebm(Uint8Array.from(Buffer.from(s, 'base64')))
    totalPackets += packets.length
    console.log(`  段: ${packets.length} 个 opus 包`)
    if (packets.length) send({ type: 'packets', packets: packets.map((p) => Buffer.from(p).toString('base64')) })
    // 排空已到事件，模拟实时上屏
    for (let k = 0; k < 20; k++) {
      const idx = events.findIndex((m) => m.type === 'interim')
      if (idx < 0) break
      const m = events.splice(idx, 1)[0]
      interims.push(m.text)
      console.log('  interim:', m.text.slice(0, 70))
    }
    await sleep(800)
  }
  console.log(`[2] 共发送 ${totalPackets} 包，finish`)
  send({ type: 'finish' })
  let final = ''
  let error = null
  while (true) {
    let m
    try { m = await nextEvent(['interim', 'final', 'done', 'error'], 60000) } catch { break }
    if (m.type === 'interim') { interims.push(m.text); console.log('  interim:', m.text.slice(0, 70)) }
    if (m.type === 'final') final = m.text
    if (m.type === 'error') { error = m.error; break }
    if (m.type === 'done') break
  }
  child.kill()
  console.log('[3] 中间结果次数:', interims.length)
  console.log('[3] 最终文本:', final || '（空）')
  if (error) console.log('[3] error:', error)
} finally {
  await browser.close()
}
