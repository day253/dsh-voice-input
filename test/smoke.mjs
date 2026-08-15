#!/usr/bin/env node
/**
 * Smoke test for dsh-voice-input:
 *   1. (optional) convert a wav to webm/opus with a local ffmpeg
 *   2. extract opus packets from the webm (SAME code as the browser client)
 *   3. run the streaming Node ASR helper and print the transcription
 *
 * Usage: node test/smoke.mjs <input.wav|input.webm> [ffmpeg-path]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { streamAsr } from './asr-runner.mjs'

const input = process.argv[2]
if (!input) {
  console.error('usage: node test/smoke.mjs <input.wav|input.webm|input.ogg> [ffmpeg-path]')
  process.exit(2)
}
let ffmpeg = process.argv[3] || process.env.FFMPEG || null
let mediaPath = input
if (input.endsWith('.wav')) {
  if (!ffmpeg) throw new Error('转换 wav 需要 ffmpeg 路径（第 2 个参数）')
  mediaPath = input.replace(/\.wav$/, '.webm')
  execFileSync(ffmpeg, ['-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-f', 'webm', mediaPath], { stdio: 'ignore' })
  console.log(`[1] wav -> webm/opus: ${mediaPath}`)
}
const buf = readFileSync(mediaPath)
console.log(`[2] ${mediaPath} ${buf.length} bytes, 提取 opus 包中...`)
const packets = extractOpusPackets(buf, mediaPath)
console.log(`[2] 共 ${packets.length} 个 opus 包（约 ${(packets.length * 20 / 1000).toFixed(1)}s 音频）`)

console.log('[3] 流式 ASR ...')
const result = await streamAsr({ packets, cacheDir: '/tmp/dsh-voice-test-cache-smoke', batchMs: 150, onInterim: null })
console.log('[3] interim 次数:', result.interims.length)
if (result.interims.length) console.log('[3] 首个 interim:', result.interims[0].slice(0, 60))
console.log('[3] final:', result.ok ? result.final : '（失败）')
if (!result.ok) console.log('[3] error:', result.error)
if (result.stderr.trim()) console.log('[stderr]', result.stderr.trim().slice(0, 500))

// ---------- 与 plugin/client.js 一致的解析代码 ----------
function readVint(dv, pos) {
  const first = dv.getUint8(pos)
  if (first === 0) throw new Error('EBML: 非法的 varint')
  let len = 1
  let mask = 0x80
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++ }
  let value = first & (mask - 1)
  for (let i = 1; i < len; i++) value = value * 256 + dv.getUint8(pos + i)
  return { value, len, id: value + mask * Math.pow(256, len - 1) }
}
function extractOpusPackets(buf, mediaPath) {
  if (mediaPath.endsWith('.ogg')) {
    const packets = []
    let pos = 0
    let acc = []
    while (pos + 27 < buf.length) {
      const numSegs = buf[pos + 26]
      const tableStart = pos + 27
      let payloadLen = 0
      for (let i = 0; i < numSegs; i++) payloadLen += buf[tableStart + i]
      const payload = buf.subarray(tableStart + numSegs, tableStart + numSegs + payloadLen)
      let p = 0
      for (let i = 0; i < numSegs; i++) {
        const segLen = buf[tableStart + i]
        for (let j = 0; j < segLen; j++) acc.push(payload[p + j])
        p += segLen
        if (segLen < 255) {
          const packet = new Uint8Array(acc)
          acc = []
          if (packet.length >= 8) {
            let magic = ''
            for (let k = 0; k < 8; k++) magic += String.fromCharCode(packet[k])
            if (magic !== 'OpusHead' && magic !== 'OpusTags' && packet.length > 0) packets.push(packet)
          }
        }
      }
      pos = tableStart + numSegs + payloadLen
    }
    return packets
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
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
