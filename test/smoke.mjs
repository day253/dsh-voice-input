#!/usr/bin/env node
/**
 * Smoke test for dsh-voice-input:
 *   1. (optional) convert a wav to webm/opus with a local ffmpeg
 *   2. extract opus packets from the webm (SAME code as the browser client)
 *   3. run the pure-Node ASR helper and print the transcription
 *
 * Usage: node test/smoke.mjs <input.wav|input.webm> [ffmpeg-path]
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const helper = path.join(here, '..', 'asr_helper.mjs')

// ---------------------------------------------------------------------------
// EBML / WebM opus packet extraction — 与客户端插件代码保持一致
// ---------------------------------------------------------------------------

function readVint(dv, pos) {
  const first = dv.getUint8(pos)
  if (first === 0) throw new Error('EBML: 非法的 varint')
  let len = 1
  let mask = 0x80
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++ }
  let value = first & (mask - 1)
  for (let i = 1; i < len; i++) value = value * 256 + dv.getUint8(pos + i)
  const id = value + mask * Math.pow(256, len - 1) // 元素 ID 保留 marker 位
  return { value, len, id }
}

function readUint(dv, pos, len) {
  let v = 0
  for (let i = 0; i < len; i++) v = v * 256 + dv.getUint8(pos + i)
  return v
}

function parseTracks(dv, start, end) {
  let pos = start
  const audioTracks = []
  while (pos < end) {
    const id = readVint(dv, pos); pos += id.len
    const size = readVint(dv, pos); pos += size.len
    const next = pos + size.value
    if (id.id === 0xAE) { // TrackEntry
      let trackNumber = 0
      let codecId = ''
      let p = pos
      while (p < next) {
        const cid = readVint(dv, p); p += cid.len
        const csize = readVint(dv, p); p += csize.len
        if (cid.id === 0xD7) trackNumber = readUint(dv, p, csize.value)
        if (cid.id === 0x86) codecId = String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + p, csize.value))
        p += csize.value
      }
      if (codecId.startsWith('A_OPUS')) audioTracks.push(trackNumber)
    }
    pos = next
  }
  return audioTracks
}

function extractBlockPackets(dv, blockPayload) {
  // block: track vint + int16 rel timestamp + flags byte + frame(s)
  const pdv = new DataView(blockPayload.buffer, blockPayload.byteOffset, blockPayload.byteLength)
  const track = readVint(pdv, 0)
  const flags = pdv.getUint8(track.len + 2)
  const lacing = (flags >> 1) & 0x03
  let data = blockPayload.subarray(track.len + 3)
  const packets = []
  if (lacing === 0) {
    if (data.length) packets.push(Array.from(data))
  } else if (lacing === 2) { // fixed-size lacing
    const count = data[0] + 1
    const body = data.subarray(1)
    const size = Math.floor(body.length / count)
    for (let i = 0; i < count; i++) {
      const pkt = body.subarray(i * size, (i + 1) * size)
      if (pkt.length) packets.push(Array.from(pkt))
    }
  } else {
    throw new Error('EBML: 不支持 xiph/EBML lacing')
  }
  return { track: track.value, packets }
}

function extractOpusPacketsFromWebm(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 0
  // EBML header
  const ebmlId = readVint(dv, pos); pos += ebmlId.len
  if (ebmlId.id !== 0x1A45DFA3) throw new Error('不是 EBML/WebM 文件')
  const ebmlSize = readVint(dv, pos); pos += ebmlSize.len
  pos += ebmlSize.value
  // Segment
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
    if (id.id === 0x1654AE6B) { // Tracks
      audioTracks = parseTracks(dv, pos, next)
    } else if (id.id === 0x1F43B675) { // Cluster
      let p = pos
      while (p < next) {
        const cid = readVint(dv, p); p += cid.len
        const csize = readVint(dv, p); p += csize.len
        const cnext = p + csize.value
        if (cid.id === 0xA3 || cid.id === 0xA1) { // SimpleBlock / Block
          const payload = new Uint8Array(dv.buffer, dv.byteOffset + p, csize.value)
          try {
            const { track, packets: pkts } = extractBlockPackets(dv, payload)
            if (!audioTracks || audioTracks.includes(track)) packets.push(...pkts)
          } catch {}
        }
        p = cnext
      }
    }
    pos = next
  }
  return packets
}

// ---------------------------------------------------------------------------
// 测试流程
// ---------------------------------------------------------------------------

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
  execFileSync(ffmpeg, ['-y', '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-f', 'webm', mediaPath], { stdio: 'inherit' })
  console.log(`[1] wav -> webm/opus: ${mediaPath}`)
}
const buf = readFileSync(mediaPath)
console.log(`[2] ${mediaPath} ${buf.length} bytes, 提取 opus 包中...`)
let packets
if (mediaPath.endsWith('.ogg')) {
  // 简单 Ogg 页解析（仅测试用，客户端对 ogg 走同一逻辑）
  throw new Error('ogg 暂不在 smoke 测试范围')
} else {
  packets = extractOpusPacketsFromWebm(buf)
}
console.log(`[2] 共 ${packets.length} 个 opus 包（约 ${(packets.length * 20 / 1000).toFixed(1)}s 音频）`)

console.log('[3] 调用 asr_helper.mjs ...')
const req = JSON.stringify({
  packets: packets.map((p) => Buffer.from(p).toString('base64')),
  cache_dir: '/tmp/dsh-voice-test-cache-node',
})
const child = spawn(process.execPath, [helper], { stdio: ['pipe', 'pipe', 'inherit'] })
let out = ''
child.stdout.on('data', (c) => (out += c))
child.stdin.end(req)
child.on('close', (code) => {
  console.log(`[3] exit ${code}: ${out.trim()}`)
})
