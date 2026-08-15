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
 * 用途：被 DeepSeek Harness 的 dsh-voice-input 插件以子进程方式调用。
 * 输入（stdin）：一行 JSON
 *   {"packets": ["<base64 opus 包>", ...], "cache_dir": "<凭据缓存目录>"}
 * 输出（stdout）：一行 JSON
 *   {"ok": true, "text": "..."}  或  {"ok": false, "error": "..."}
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

// ---------------------------------------------------------------------------
// protobuf（手写，schema 见 doubaoime-asr 的 asr.proto）
// ---------------------------------------------------------------------------

function varint(n) {
  const out = []
  let v = BigInt(n) & 0xffffffffffffffffn
  while (true) {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v) out.push(b | 0x80)
    else { out.push(b); return Buffer.from(out) }
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
  try {
    creds = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch { creds = null }
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

function recvMessage(ws, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('WS 接收超时')) }, timeoutMs)
    const onMsg = (ev) => { cleanup(); resolve(new Uint8Array(ev.data)) }
    const onErr = () => { cleanup(); reject(new Error('WS 连接出错')) }
    const onClose = (ev) => { cleanup(); reject(new Error(`WS 连接关闭 (code ${ev.code})`)) }
    const cleanup = () => {
      clearTimeout(timer)
      ws.removeEventListener('message', onMsg)
      ws.removeEventListener('error', onErr)
      ws.removeEventListener('close', onClose)
    }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('error', onErr)
    ws.addEventListener('close', onClose)
  })
}

// ---------------------------------------------------------------------------
// ASR 会话
// ---------------------------------------------------------------------------

async function runSession(creds, packets) {
  const url = `${WS_URL}?aid=${AID}&device_id=${creds.device_id}`
  const ws = await openWs(url)
  const requestId = randomUUID()
  try {
    ws.send(encodeAsrRequest({ token: creds.token, method: 'StartTask', requestId }))
    let resp = decodeAsrResponse(await recvMessage(ws))
    if (resp.message_type === 'TaskFailed' || resp.message_type === 'SessionFailed') {
      throw new Error(`StartTask 失败: ${resp.status_message}`)
    }
    if (resp.message_type !== 'TaskStarted') throw new Error(`StartTask 返回异常: ${resp.message_type}`)

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
    resp = decodeAsrResponse(await recvMessage(ws))
    if (resp.message_type === 'TaskFailed' || resp.message_type === 'SessionFailed') {
      throw new Error(`StartSession 失败: ${resp.status_message}`)
    }
    if (resp.message_type !== 'SessionStarted') throw new Error(`StartSession 返回异常: ${resp.message_type}`)

    const startMs = Date.now()
    const n = packets.length
    for (let i = 0; i < n; i++) {
      const state = i === 0 ? 1 : (i === n - 1 ? 9 : 3) // FIRST / LAST / MIDDLE
      const payload = JSON.stringify({ extra: {}, timestamp_ms: startMs + i * FRAME_MS })
      ws.send(encodeAsrRequest({ method: 'TaskRequest', payload, audio: packets[i], requestId, frameState: state }))
    }
    ws.send(encodeAsrRequest({ token: creds.token, method: 'FinishSession', requestId }))

    let finalText = ''
    let lastInterim = ''
    while (true) {
      resp = decodeAsrResponse(await recvMessage(ws))
      if (resp.message_type === 'TaskFailed' || resp.message_type === 'SessionFailed') {
        throw new Error(`会话失败: ${resp.status_message}`)
      }
      if (resp.message_type === 'SessionFinished') break
      if (!resp.result_json) continue
      let data
      try { data = JSON.parse(resp.result_json) } catch { continue }
      const results = data.results
      if (!results) continue
      let text = '', isInterim = true, vadFinished = false, nonstream = false
      for (const r of results) {
        if (r.text) text = r.text
        if (r.is_interim === false) isInterim = false
        if (r.is_vad_finished) vadFinished = true
        if (r.extra?.nonstream_result) nonstream = true
      }
      if (nonstream || (!isInterim && vadFinished)) finalText = text
      else lastInterim = text
    }
    return finalText || lastInterim
  } finally {
    try { ws.close() } catch {}
  }
}

async function transcribe(packets, cacheDir) {
  const { creds, file } = await loadOrRegisterCredentials(cacheDir)
  try {
    return await runSession(creds, packets)
  } catch (firstError) {
    // 凭据可能过期：重新注册一次再试
    try {
      const fresh = await registerDevice()
      fresh.token = await fetchToken(fresh)
      await fsp.writeFile(file, JSON.stringify(fresh, null, 2))
      return await runSession(fresh, packets)
    } catch (secondError) {
      throw new Error(`${firstError.message}; 重试: ${secondError.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    console.log(JSON.stringify({ ok: false, error: 'stdin 为空' }))
    return
  }
  let req
  try { req = JSON.parse(raw) } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `请求不是合法 JSON: ${e.message}` }))
    return
  }
  const cacheDir = req.cache_dir || path.join(os.homedir(), '.cache', 'dsh-voice')
  if (!Array.isArray(req.packets) || req.packets.length === 0) {
    console.log(JSON.stringify({ ok: false, error: '缺少 packets 字段' }))
    return
  }
  let packets
  try {
    packets = req.packets.map((p) => Buffer.from(String(p), 'base64'))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `packets base64 解码失败: ${e.message}` }))
    return
  }
  if (!packets.some((p) => p.length > 0)) {
    console.log(JSON.stringify({ ok: false, error: 'packets 为空' }))
    return
  }
  try {
    const text = await transcribe(packets, cacheDir)
    console.log(JSON.stringify({ ok: true, text }))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 500) }))
  }
}

await main()
