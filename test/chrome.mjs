#!/usr/bin/env node
/**
 * Chrome 真机浏览器链路测试：
 *   1. 用本机 Chrome（--use-fake-device-for-media-stream）真实录音 2.5s
 *   2. 用与 plugin/client.js 完全一致的解析代码提取 webm 中的 Opus 包
 *   3. 交给 asr_helper.mjs 跑豆包 ASR
 *
 * 默认 fake 设备产生的是提示音；设 FAKE_AUDIO_FILE=<44.1kHz 16bit 立体声 wav>
 * 可让 fake 麦克风播放真实语音，从而断言识别文本（已验证可识别 JFK 演讲）。
 *
 * Usage: node test/chrome.mjs [chrome-path]
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, '..', 'asr_helper.mjs')
const chromePath = process.argv[2] || '/usr/bin/google-chrome'
const fakeAudioFile = process.env.FAKE_AUDIO_FILE || null // 可选：44.1kHz 16bit 立体声 wav

// ---------- 与 plugin/client.js 一致的解析代码 ----------
const parserSource = `
  function b64encode(bytes) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let out = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
      out += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)]
      out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '='
      out += i + 2 < bytes.length ? chars[b2 & 63] : '='
    }
    return out
  }
  function readVint(dv, pos) {
    const first = dv.getUint8(pos)
    if (first === 0) throw new Error('EBML: 非法的 varint')
    let len = 1
    let mask = 0x80
    while (len <= 8 && !(first & mask)) { mask >>= 1; len++ }
    let value = first & (mask - 1)
    for (let i = 1; i < len; i++) value = value * 256 + dv.getUint8(pos + i)
    const id = value + mask * Math.pow(256, len - 1)
    return { value, len, id }
  }
  function readUint(dv, pos, len) {
    let v = 0
    for (let i = 0; i < len; i++) v = v * 256 + dv.getUint8(pos + i)
    return v
  }
  function extractOpusPacketsFromWebm(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let pos = 0
    const ebmlId = readVint(dv, pos); pos += ebmlId.len
    if (ebmlId.id !== 0x1A45DFA3) throw new Error('不是 WebM 录音')
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
            let trackNumber = 0
            let codecId = ''
            let q = p
            while (q < tnext) {
              const cid = readVint(dv, q); q += cid.len
              const csize = readVint(dv, q); q += csize.len
              if (cid.id === 0xD7) trackNumber = readUint(dv, q, csize.value)
              if (cid.id === 0x86) {
                const s = new Uint8Array(dv.buffer, dv.byteOffset + q, csize.value)
                let str = ''
                for (let k = 0; k < s.length; k++) str += String.fromCharCode(s[k])
                codecId = str
              }
              q += csize.value
            }
            if (codecId.indexOf('A_OPUS') === 0) tracks.push(trackNumber)
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
            const payload = new Uint8Array(dv.buffer, dv.byteOffset + p, csize.value)
            const pdv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
            const track = readVint(pdv, 0)
            const flags = pdv.getUint8(track.len + 2)
            const lacing = (flags >> 1) & 0x03
            const data = payload.subarray(track.len + 3)
            const push = (pkt) => {
              if (pkt.length && (!audioTracks || audioTracks.indexOf(track.value) >= 0)) packets.push(pkt)
            }
            if (lacing === 0) push(data)
            else if (lacing === 2) {
              const count = data[0] + 1
              const body = data.subarray(1)
              const size2 = Math.floor(body.length / count)
              for (let i = 0; i < count; i++) push(body.subarray(i * size2, (i + 1) * size2))
            }
          }
          p = cnext
        }
      }
      pos = next
    }
    return packets
  }
  window.__parseWebm = extractOpusPacketsFromWebm
  window.__b64 = b64encode
`

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
  await page.evaluate(parserSource)
  const result = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = 'audio/webm;codecs=opus'
    const recorder = new MediaRecorder(stream, { mimeType })
    const chunks = []
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data) }
    const done = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.start()
    await new Promise((r) => setTimeout(r, 2500))
    recorder.stop()
    await done
    stream.getTracks().forEach((t) => t.stop())
    const blob = new Blob(chunks, { type: mimeType })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const packets = window.__parseWebm(bytes)
    return {
      mimeType,
      blobBytes: bytes.length,
      packetCount: packets.length,
      packets: packets.map((p) => window.__b64(p)),
    }
  })
  console.log(`[1] 真实 Chrome 录音: mime=${result.mimeType} blob=${result.blobBytes}B opus包=${result.packetCount}`)
  if (!result.packetCount) throw new Error('Chrome webm 未提取到 Opus 包')

  console.log('[2] 调用 asr_helper.mjs ...')
  const req = JSON.stringify({ packets: result.packets, cache_dir: '/tmp/dsh-voice-test-cache-chrome' })
  const child = spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  child.stdin.end(req)
  const code = await new Promise((resolve) => child.on('close', resolve))
  console.log(`[2] exit ${code}: ${out.trim()}`)
  const parsed = JSON.parse(out.trim())
  if (!parsed.ok) throw new Error('ASR 会话失败: ' + parsed.error)
  console.log('[3] 整条链路通过，识别文本: ' + (parsed.text || '（空）'))
} finally {
  await browser.close()
}
