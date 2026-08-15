#!/usr/bin/env node
/**
 * dsh-voice-input ASR helper — 豆包输入法零配置语音识别（非官方协议）
 *
 * 纯 Node 原生实现，零 npm 依赖（node >= 22，使用内置 fetch / WebSocket / crypto）。
 * 协议参考：
 *   - yangmoling/doubaoime-asr (https://github.com/yangmoling/doubaoime-asr)
 *   - day253/typeless-ibus (https://github.com/day253/typeless-ibus) 的 doubao provider
 *
 * 免责声明：该协议并非公开、稳定的商业 API，服务端行为可能随时变化，仅供学习研究。
 * 凭据文件勿提交到 Git、勿复制到其他机器。
 *
 * 流式行协议（被 DeepSeek Harness 的 dsh-voice-input 插件以子进程方式调用）：
 *
 * stdin（每行一个 JSON）：
 *   {"type":"start"}                                 开启一次 ASR 会话
 *   {"type":"packets","packets":["<base64 opus 包>"]}  追加音频（实时发送）
 *   {"type":"finish"}                                结束：标记 LAST 帧并 FinishSession
 * stdout（每行一个 JSON）：
 *   {"type":"ready"}                             会话已就绪（可开始发音频）
 *   {"type":"interim","text":"..."}              中间识别结果（实时上屏）
 *   {"type":"final","text":"..."}                最终结果（可能多次，取最后一次）
 *   {"type":"done"}                              会话结束
 *   {"type":"error","error":"..."}               出错（随后退出）
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

const REGISTER_URL = 'https://log.snssdk.com/service/2/device_register/'
const SETTINGS_URL = 'https://is.snssdk.com/service/settings/v3/'
const WS_URL = 'wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws'
const AID = 401734
const APP_CONFIG = {
  aid: AID,
  app_name: 'oime',
  version_code: 100102018,
  version_name: '1.1.2',
  manifest_version_code: 100102018,
  update_version_code: 100102018,
  channel: 'official',
  package: 'com.bytedance.android.doubaoime',
}
const DEVICE_CONFIG = {
  device_platform: 'android',
  os: 'android',
  os_api: '34',
  os_version: '16',
  device_type: 'Pixel 7 Pro',
  device_brand: 'google',
  device_model: 'Pixel 7 Pro',
  resolution: '1080*2400',
  dpi: '420',
  language: 'zh',
  timezone: 8,
  access: 'wifi',
  rom: 'UP1A.231005.007',
  rom_version: 'UP1A.231005.007',
}
const USER_AGENT =
  'com.bytedance.android.doubaoime/100102018 (Linux; U; Android 16; en_US; ' +
  'Pixel 7 Pro; Build/BP2A.250605.031.A2; Cronet/TTNetVersion:94cf429a ' +
  '2025-11-17 QuicVersion:1f89f732 2025-05-08)'

const SAMPLE_RATE = 16000
const FRAME_MS = 20

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const fail = (message) => {
  out({ type: 'error', error: String(message).slice(0, 500) })
  setTimeout(() => process.exit(1), 60)
}

// ---------------------------------------------------------------------------
// protobuf（手写，schema 见 doubaoime-asr 的 asr.proto）
// ---------------------------------------------------------------------------

function varint(n) {
  const outArr = []
  let v = BigInt(n) & 0xffffffffffffffffn
  while (true) {
    const b = Number(v & 0x7fn)
    v >>= 7n
    if (v) outArr.push(b | 0x80)
    else { outArr.push(b); return Buffer.from(outArr) }
  }
}
function pbField(field, wire, payload) {
  return Buffer.concat([varint((field << 3) | wire), payload])
}
function pbStr(field, value) {
  const data = Buffer.from(String(value), 'utf8')
  return pbField(field, 2, Buffer.concat([varint(data.length), data]))
}
function pbBytes(field, value) {
  const data = Buffer.from(value)
  return pbField(field, 2, Buffer.concat([varint(data.length), data]))
}
function pbInt(field, value) {
  return pbField(field, 0, varint(value))
}
function encodeAsrRequest({ token = '', method, payload = '', audio = null, requestId, frameState = null }) {
  const parts = []
  if (token) parts.push(pbStr(2, token))
  parts.push(pbStr(3, 'ASR'))
  parts.push(pbStr(5, method))
  if (payload) parts.push(pbStr(6, payload))
  if (audio && audio.length) parts.push(pbBytes(7, audio))
  parts.push(pbStr(8, requestId))
  if (frameState !== null) parts.push(pbInt(9, frameState))
  return Buffer.concat(parts)
}
function decodeAsrResponse(buf) {
  const result = {}
  let i = 0
  while (i < buf.length) {
    let tag = 0, shift = 0, b
    do { b = buf[i++]; tag |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
    const field = tag >> 3, wire = tag & 7
    if (wire === 0) {
      let val = 0; shift = 0
      do { b = buf[i++]; val |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
      result[field] = val
    } else if (wire === 2) {
      let len = 0; shift = 0
      do { b = buf[i++]; len |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
      result[field] = buf.subarray(i, i + len)
      i += len
    } else {
      throw new Error(`unsupported wire type ${wire}`)
    }
  }
  const str = (f) => (result[f] ? Buffer.from(result[f]).toString('utf8') : '')
  return {
    request_id: str(1),
    task_id: str(2),
    message_type: str(4),
    status_code: result[5] || 0,
    status_message: str(6),
    result_json: str(7),
  }
}

// ---------------------------------------------------------------------------
// 设备注册 / 取 token
// ---------------------------------------------------------------------------

async function postJson(url, params, body, headers) {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { throw new Error(`响应不是 JSON（HTTP ${res.status}）: ${text.slice(0, 120)}`) }
  return data
}
function genIds() {
  return { cdid: randomUUID(), openudid: randomBytes(8).toString('hex'), clientudid: randomUUID() }
}
async function registerDevice() {
  const ids = genIds()
  const nowMs = Date.now()
  const params = {
    device_platform: 'android', os: 'android', ssmix: 'a', _rticket: String(nowMs),
    cdid: ids.cdid,
    channel: APP_CONFIG.channel, aid: String(AID), app_name: APP_CONFIG.app_name,
    version_code: String(APP_CONFIG.version_code), version_name: APP_CONFIG.version_name,
    manifest_version_code: String(APP_CONFIG.manifest_version_code),
    update_version_code: String(APP_CONFIG.update_version_code),
    resolution: DEVICE_CONFIG.resolution, dpi: DEVICE_CONFIG.dpi,
    device_type: DEVICE_CONFIG.device_type, device_brand: DEVICE_CONFIG.device_brand,
    language: DEVICE_CONFIG.language, os_api: DEVICE_CONFIG.os_api,
    os_version: DEVICE_CONFIG.os_version, ac: 'wifi',
  }
  const header = {
    ...APP_CONFIG, ...DEVICE_CONFIG,
    device_id: 0, install_id: 0,
    openudid: ids.openudid, clientudid: ids.clientudid, cdid: ids.cdid,
    region: 'CN', tz_name: 'Asia/Shanghai', tz_offset: 28800,
    sim_region: 'cn', carrier_region: 'cn', cpu_abi: 'arm64-v8a',
    build_serial: 'unknown', not_request_sender: 0, sig_hash: '',
    google_aid: '', mc: '', serial_number: '',
  }
  const body = { magic_tag: 'ss_app_log', header, _gen_time: nowMs }
  const resp = await postJson(REGISTER_URL, params, body, {})
  const deviceId = Number(resp.device_id || 0)
  const installId = Number(resp.install_id || 0)
  if (!deviceId) throw new Error(`device_register 返回异常: ${JSON.stringify(resp).slice(0, 200)}`)
  return { device_id: String(deviceId), install_id: String(installId), ...ids, token: '' }
}
async function fetchToken(creds) {
  const params = {
    device_platform: 'android', os: 'android', ssmix: 'a', _rticket: String(Date.now()),
    cdid: creds.cdid, channel: APP_CONFIG.channel, aid: String(AID),
    app_name: APP_CONFIG.app_name, version_code: String(APP_CONFIG.version_code),
    version_name: APP_CONFIG.version_name, device_id: creds.device_id,
  }
  const bodyStr = 'body=null'
  const stub = createHash('md5').update(bodyStr).digest('hex').toUpperCase()
  const data = await postJson(SETTINGS_URL, params, bodyStr, { 'x-ss-stub': stub })
  const appKey = data?.data?.settings?.asr_config?.app_key || ''
  if (!appKey) throw new Error(`settings 未返回 app_key: ${JSON.stringify(data).slice(0, 200)}`)
  return appKey
}
async function loadOrRegisterCredentials(cacheDir) {
  const file = path.join(cacheDir, 'credentials.json')
  let creds = null
  try { creds = JSON.parse(await fsp.readFile(file, 'utf8')) } catch { creds = null }
  if (creds?.device_id && creds?.token) return { creds, file }
  creds = await registerDevice()
  creds.token = await fetchToken(creds)
  try {
    await fsp.mkdir(cacheDir, { recursive: true })
    await fsp.writeFile(file, JSON.stringify(creds, null, 2))
  } catch {}
  return { creds, file }
}

// ---------------------------------------------------------------------------
// WebSocket（Node 内置全局 WebSocket，带自定义 headers）
// ---------------------------------------------------------------------------

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'proto-version': 'v2',
        'x-custom-keepalive': 'true',
      },
    })
    ws.binaryType = 'arraybuffer'
    const onError = (ev) => reject(new Error(`WS 连接失败: ${ev?.message || ev?.error || 'unknown'}`))
    ws.addEventListener('error', onError, { once: true })
    ws.addEventListener('open', () => {
      ws.removeEventListener('error', onError)
      resolve(ws)
    }, { once: true })
  })
}

// ---------------------------------------------------------------------------
// 流式 ASR 会话
// ---------------------------------------------------------------------------

let ws = null
let requestId = null
let creds = null
let credsFile = null
let cacheDir = null
let frameIndex = 0
let sessionStartMs = 0
let sessionActive = false

function handleWsMessage(ev) {
  let resp
  try {
    resp = decodeAsrResponse(new Uint8Array(ev.data))
  } catch (e) {
    out({ type: 'error', error: 'ASR 响应解析失败: ' + String(e.message || e) })
    return
  }
  if (resp.message_type === 'TaskFailed' || resp.message_type === 'SessionFailed') {
    out({ type: 'error', error: '会话失败: ' + resp.status_message })
    return
  }
  if (resp.message_type === 'SessionFinished') {
    sessionActive = false
    out({ type: 'done' })
    setTimeout(() => process.exit(0), 80)
    return
  }
  if (!resp.result_json) return
  let data
  try { data = JSON.parse(resp.result_json) } catch { return }
  const results = data.results
  if (!results) return
  let text = '', isInterim = true, vadFinished = false, nonstream = false
  for (const r of results) {
    if (r.text) text = r.text
    if (r.is_interim === false) isInterim = false
    if (r.is_vad_finished) vadFinished = true
    if (r.extra?.nonstream_result) nonstream = true
  }
  if (nonstream || (!isInterim && vadFinished)) out({ type: 'final', text })
  else out({ type: 'interim', text })
}

function attachWs(ws) {
  ws.addEventListener('message', handleWsMessage)
  ws.addEventListener('close', () => {
    if (sessionActive) {
      sessionActive = false
      out({ type: 'error', error: 'WS 连接被服务端关闭' })
      setTimeout(() => process.exit(1), 80)
    }
  })
}

function sendPackets(packets, lastOne) {
  for (let i = 0; i < packets.length; i++) {
    let state = 3 // MIDDLE
    if (frameIndex === 0) state = 1 // FIRST
    if (lastOne && i === packets.length - 1) state = 9 // LAST
    const payload = JSON.stringify({ extra: {}, timestamp_ms: sessionStartMs + frameIndex * FRAME_MS })
    ws.send(encodeAsrRequest({ method: 'TaskRequest', payload, audio: packets[i], requestId, frameState: state }))
    frameIndex++
  }
}

async function startSession() {
  if (sessionActive) {
    out({ type: 'ready' })
    return
  }
  const loaded = await loadOrRegisterCredentials(cacheDir)
  creds = loaded.creds
  credsFile = loaded.file
  const url = `${WS_URL}?aid=${AID}&device_id=${creds.device_id}`
  ws = await openWs(url)
  attachWs(ws)
  requestId = randomUUID()
  frameIndex = 0
  sessionStartMs = Date.now()

  ws.send(encodeAsrRequest({ token: creds.token, method: 'StartTask', requestId }))
  const taskResp = await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      ws.removeEventListener('message', onMsg)
      try { resolve(decodeAsrResponse(new Uint8Array(ev.data))) } catch (e) { reject(e) }
    }
    const onErr = () => { ws.removeEventListener('message', onMsg); reject(new Error('WS 出错')) }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('error', onErr, { once: true })
  })
  if (taskResp.message_type === 'TaskFailed' || taskResp.message_type === 'SessionFailed') {
    throw new Error(`StartTask 失败: ${taskResp.status_message}`)
  }
  if (taskResp.message_type !== 'TaskStarted') throw new Error(`StartTask 返回异常: ${taskResp.message_type}`)

  const sessionPayload = JSON.stringify({
    audio_info: { channel: 1, format: 'speech_opus', sample_rate: SAMPLE_RATE },
    enable_punctuation: true,
    enable_speech_rejection: false,
    extra: {
      app_name: 'com.android.chrome',
      cell_compress_rate: 8,
      did: creds.device_id,
      enable_asr_threepass: true,
      enable_asr_twopass: true,
      input_mode: 'tool',
    },
  })
  ws.send(encodeAsrRequest({ token: creds.token, method: 'StartSession', payload: sessionPayload, requestId }))
  const sessResp = await new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      ws.removeEventListener('message', onMsg)
      try { resolve(decodeAsrResponse(new Uint8Array(ev.data))) } catch (e) { reject(e) }
    }
    const onErr = () => { ws.removeEventListener('message', onMsg); reject(new Error('WS 出错')) }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('error', onErr, { once: true })
  })
  if (sessResp.message_type === 'TaskFailed' || sessResp.message_type === 'SessionFailed') {
    throw new Error(`StartSession 失败: ${sessResp.status_message}`)
  }
  if (sessResp.message_type !== 'SessionStarted') throw new Error(`StartSession 返回异常: ${sessResp.message_type}`)

  sessionActive = true
  out({ type: 'ready' })
}

async function retryWithFreshCredentials(fn) {
  try {
    await fn()
  } catch (firstError) {
    try {
      const fresh = await registerDevice()
      fresh.token = await fetchToken(fresh)
      await fsp.writeFile(credsFile, JSON.stringify(fresh, null, 2))
      creds = fresh
      if (ws) { try { ws.close() } catch {} }
      await fn()
    } catch (secondError) {
      fail(`${firstError.message}; 重试: ${secondError.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// stdin 行协议入口
// ---------------------------------------------------------------------------

async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const cacheDirArg = process.argv[2]
  cacheDir = cacheDirArg || path.join(os.homedir(), '.cache', 'dsh-voice')

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg
    try { msg = JSON.parse(trimmed) } catch (e) {
      fail(`请求不是合法 JSON: ${e.message}`)
      return
    }
    try {
      if (msg.type === 'start') {
        await retryWithFreshCredentials(startSession)
      } else if (msg.type === 'packets') {
        if (!sessionActive) fail('会话未开启，请先发送 start')
        const packets = (Array.isArray(msg.packets) ? msg.packets : [])
          .map((p) => Buffer.from(String(p), 'base64'))
          .filter((p) => p.length > 0)
        if (packets.length) sendPackets(packets, false)
      } else if (msg.type === 'finish') {
        if (!sessionActive) fail('会话未开启，请先发送 start')
        const packets = (Array.isArray(msg.packets) ? msg.packets : [])
          .map((p) => Buffer.from(String(p), 'base64'))
          .filter((p) => p.length > 0)
        sendPackets(packets, packets.length > 0)
        ws.send(encodeAsrRequest({ token: creds.token, method: 'FinishSession', requestId }))
      } else {
        fail(`未知消息类型: ${msg.type}`)
      }
    } catch (e) {
      fail(String(e?.message || e))
      return
    }
  }
  // stdin 关闭（宿主终止进程）→ 退出
  process.exit(0)
}

main()
