// dsh-voice-input — 客户端（Client half）
// 作为 DeepSeek Harness 动态 Cordis 插件的 client 代码使用。
// 职责：在输入框工具行（conversation.input.right）注册一个麦克风按钮；
// 点按录音（MediaRecorder 产出 Opus 的 webm/ogg），停止后从容器中提取
// Opus 包，经 host.call('transcribe') 交给宿主端识别，结果写入输入框。
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    // ---------- base64 ----------
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

    // ---------- EBML / WebM ----------
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
        if (id.id === 0x1654AE6B) { // Tracks
          const tracks = []
          let p = pos
          while (p < next) {
            const tid = readVint(dv, p); p += tid.len
            const tsize = readVint(dv, p); p += tsize.len
            const tnext = p + tsize.value
            if (tid.id === 0xAE) { // TrackEntry
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
        } else if (id.id === 0x1F43B675) { // Cluster
          let p = pos
          while (p < next) {
            const cid = readVint(dv, p); p += cid.len
            const csize = readVint(dv, p); p += csize.len
            const cnext = p + csize.value
            if (cid.id === 0xA3 || cid.id === 0xA1) { // SimpleBlock / Block
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
              else if (lacing === 2) { // fixed lacing
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

    // ---------- Ogg ----------
    function extractOpusPacketsFromOgg(bytes) {
      const packets = []
      let pos = 0
      let acc = []
      while (pos + 27 < bytes.length) {
        if (bytes[pos] !== 0x4F || bytes[pos + 1] !== 0x67 || bytes[pos + 2] !== 0x67 || bytes[pos + 3] !== 0x53) {
          throw new Error('不是 Ogg 录音')
        }
        const numSegs = bytes[pos + 26]
        const tableStart = pos + 27
        let payloadLen = 0
        for (let i = 0; i < numSegs; i++) payloadLen += bytes[tableStart + i]
        const payload = bytes.subarray(tableStart + numSegs, tableStart + numSegs + payloadLen)
        let p = 0
        for (let i = 0; i < numSegs; i++) {
          const segLen = bytes[tableStart + i]
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

    // ---------- 样式 ----------
    ctx.effect(() => styles.insert(`
      .dv-mic-wrap { position: relative; display: inline-flex; align-items: center; }
      .dv-mic-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; border: none; cursor: pointer; background: transparent; color: var(--ds-color-text-secondary, #8a8f98); transition: color .15s, background .15s; padding: 0; }
      .dv-mic-btn:hover { color: var(--ds-color-text-primary, #333); background: rgba(128, 128, 128, .15); }
      .dv-mic-btn[disabled] { cursor: not-allowed; opacity: .65; }
      .dv-mic-btn.dv-recording { color: #fff; background: #e5484d; animation: dv-mic-pulse 1.2s ease-in-out infinite; }
      @keyframes dv-mic-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(229, 72, 77, .45); } 50% { box-shadow: 0 0 0 6px rgba(229, 72, 77, 0); } }
      .dv-mic-spinner { width: 14px; height: 14px; border: 2px solid rgba(128, 128, 128, .35); border-top-color: currentColor; border-radius: 50%; animation: dv-mic-rot .8s linear infinite; }
      @keyframes dv-mic-rot { to { transform: rotate(360deg); } }
      .dv-mic-err { position: absolute; bottom: calc(100% + 6px); right: 0; max-width: 240px; background: #b3261e; color: #fff; font-size: 12px; line-height: 1.4; padding: 6px 8px; border-radius: 6px; z-index: 50; }
    `))

    const runtime = { recorder: null, mimeType: null }

    function MicButton(props) {
      const [status, setStatus] = React.useState('idle')
      const [error, setError] = React.useState(null)

      React.useEffect(() => () => {
        if (runtime.recorder && runtime.recorder.state === 'recording') {
          try { runtime.recorder.stop() } catch (e) {}
        }
      }, [])

      const finish = (blob) => {
        setStatus('processing')
        setError(null)
        blob.arrayBuffer().then((ab) => {
          let packets
          try {
            const bytes = new Uint8Array(ab)
            packets = runtime.mimeType.indexOf('ogg') >= 0
              ? extractOpusPacketsFromOgg(bytes)
              : extractOpusPacketsFromWebm(bytes)
          } catch (e) {
            setError('音频解析失败：' + String((e && e.message) || e))
            setStatus('idle')
            return
          }
          if (!packets.length) {
            setError('没有提取到有效音频，请靠近麦克风重试')
            setStatus('idle')
            return
          }
          host.call('transcribe', { packets: packets.map((p) => b64encode(p)) }).then((res) => {
            if (res && res.ok === true && res.text) {
              props.inputActions.setDraft(res.text)
              setStatus('idle')
            } else {
              setError((res && res.error) || '语音识别失败')
              setStatus('idle')
            }
          }).catch((e) => {
            setError('语音识别调用失败：' + String((e && e.message) || e))
            setStatus('idle')
          })
        }).catch((e) => {
          setError('读取录音失败：' + String((e && e.message) || e))
          setStatus('idle')
        })
      }

      const start = () => {
        setError(null)
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setError('当前浏览器不支持麦克风（需 HTTPS）')
          return
        }
        if (typeof MediaRecorder === 'undefined') {
          setError('当前浏览器不支持录音')
          return
        }
        let mimeType = null
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus'
        else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) mimeType = 'audio/ogg;codecs=opus'
        if (!mimeType) {
          setError('当前浏览器不支持 Opus 录音（iOS Safari 请使用系统听写）')
          return
        }
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((stream) => {
          const chunks = []
          const recorder = new MediaRecorder(stream, { mimeType })
          runtime.recorder = recorder
          runtime.mimeType = mimeType
          recorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) chunks.push(ev.data)
          }
          recorder.onstop = () => {
            stream.getTracks().forEach((t) => { try { t.stop() } catch (e) {} })
            runtime.recorder = null
            finish(new Blob(chunks, { type: mimeType }))
          }
          recorder.start()
          setStatus('recording')
        }).catch((e) => {
          setError('无法访问麦克风：' + String((e && e.message) || e))
          setStatus('idle')
        })
      }

      const onClick = () => {
        if (status === 'processing') return
        if (status === 'recording') {
          if (runtime.recorder) {
            try { runtime.recorder.stop() } catch (e) {}
          }
          return
        }
        start()
      }

      const label = status === 'recording' ? '停止并识别' : status === 'processing' ? '识别中…' : '语音输入'

      return React.createElement('span', { className: 'dv-mic-wrap', title: label },
        error ? React.createElement('span', { className: 'dv-mic-err', onClick: () => setError(null) }, error) : null,
        React.createElement('button', {
          type: 'button',
          className: 'dv-mic-btn' + (status === 'recording' ? ' dv-recording' : ''),
          'aria-label': label,
          disabled: status === 'processing',
          onClick,
        },
          status === 'processing'
            ? React.createElement('span', { className: 'dv-mic-spinner' })
            : React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' },
                status === 'recording'
                  ? React.createElement('rect', { x: 7, y: 7, width: 10, height: 10, rx: 1.5 })
                  : React.createElement('path', { d: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z' })
              )
        )
      )
    }

    slots.inject('conversation.input.right', () => slots.register(
      { name: 'conversation.input.right', id: 'voice-input-mic', order: 5, label: '语音输入' },
      (props) => React.createElement(MicButton, { inputActions: props.inputActions }),
    ))
  },
}
