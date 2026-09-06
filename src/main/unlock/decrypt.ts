// QQ 音乐加密文件解密：文件级解码器（移植自 showhwa/UnlockMusicProject_Archive
// tmp/cli/algo/qmc/qmc.go searchKey/Validate/Read）。
// 输入完整加密文件字节，输出解密后的原容器音频（flac/ogg/mp3 等）+ 嗅探出的扩展名。
// musicex（"cex\0" 结尾）与 STag 无内嵌密钥 → 明确报错。
import { readUInt32BE, readUInt32LE } from './bytes'
import { deriveKey } from './derive'
import { createCipher } from './ciphers'

export type QmcAudioExt = 'flac' | 'ogg' | 'mp3' | 'm4a' | 'mp4' | 'wav' | 'wma' | 'dff'

export interface QmcDecryptResult {
  audio: Uint8Array // 解密后的原容器音频（不含 QTag/密钥尾部）
  ext: QmcAudioExt
  /** QTag 内嵌的歌曲 ID（补全管线可用） */
  songId?: number
}

export interface QmcError extends Error {
  kind: 'format' | 'key' | 'cipher'
}

function qmcError(kind: QmcError['kind'], message: string): QmcError {
  const e = new Error(message) as QmcError
  e.kind = kind
  return e
}

/** 解密整个加密文件（qmc.go searchKey + Validate + 全量 Read 的等价实现；整文件装入内存） */
export function decryptQmcFile(file: Uint8Array): QmcDecryptResult {
  const fileSize = file.length
  if (fileSize < 4) throw qmcError('format', '文件过短，无法识别')

  const suffix = file.subarray(fileSize - 4)

  // --- searchKey（qmc.go:120-203）：读尾部判定密钥来源 ---
  let audioLen = fileSize
  let decodedKey: Uint8Array | null = null
  let songId: number | undefined

  const suffixText = String.fromCharCode(...suffix)
  if (suffixText === 'QTag') {
    // QTag：再往前 4 字节（BE）是 rawMetaLen，元数据 = base64key,songID,extra（逗号分隔 3 段）
    const rawMetaLen = readUInt32BE(file, fileSize - 8)
    if (rawMetaLen < 3 || rawMetaLen > fileSize - 8) throw qmcError('format', 'QTag 元数据长度非法')
    audioLen = fileSize - 8 - rawMetaLen
    const metaText = String.fromCharCode(...file.subarray(fileSize - 8 - rawMetaLen, fileSize - 8))
    const items = metaText.split(',')
    if (items.length !== 3) throw qmcError('format', 'QTag 元数据格式错误（需 3 段）')
    decodedKey = deriveKey(Buffer.from(items[0], 'latin1'))
    const id = Number(items[1])
    if (!Number.isInteger(id) || id <= 0) throw qmcError('format', 'QTag 歌曲 ID 非法')
    songId = id
  } else if (suffixText === 'STag') {
    throw qmcError('key', "STag 结尾的文件不含密钥，无法解密")
  } else if (suffixText === 'cex\0') {
    // musicex：尾部 tag 只有文件名，密钥在 Mac/Android 的 MMKV 里，Windows 侧无密钥
    throw qmcError('key', 'musicex 格式无内嵌密钥（密钥仅在 Mac/Android 客户端），无法解密')
  } else {
    const size = readUInt32LE(file, fileSize - 4)
    if (size > 0 && size <= 0xffff) {
      // raw-key：最后 size 字节 = base64 密钥（含 NUL 尾），解密范围 = 前面部分
      audioLen = fileSize - 4 - size
      if (audioLen < 0) throw qmcError('format', '密钥长度超出文件范围')
      const rawKey = file.subarray(fileSize - 4 - size, fileSize - 4)
      // 去尾 NUL（qmc.go readRawKey 的 TrimRight("\x00")）
      let end = rawKey.length
      while (end > 0 && rawKey[end - 1] === 0) end--
      decodedKey = deriveKey(rawKey.subarray(0, end))
    } else {
      // 无密钥：static 密码（qmc0 老格式），全文件都是音频
      audioLen = fileSize
    }
  }

  // --- Validate（qmc.go:88-118）：解密首 64 字节嗅探容器魔数 ---
  const cipher = decodedKey ? createCipher(decodedKey) : createCipher(new Uint8Array(0))
  const headLen = Math.min(64, audioLen)
  const head = new Uint8Array(file.subarray(0, headLen))
  cipher.decrypt(head, 0)
  const ext = sniffAudio(head)
  if (!ext) throw qmcError('cipher', '无法识别解密后的音频格式（密钥不匹配或文件损坏）')

  // --- Read 全量 ---
  const audio = new Uint8Array(audioLen)
  audio.set(file.subarray(0, audioLen))
  cipher.decrypt(audio, 0)

  return { audio, ext, songId }
}

/** 容器嗅探（对应 Go sniff.AudioExtension；另加无 ID3 头的 MPEG 帧同步兜底） */
export function sniffAudio(header: Uint8Array): QmcAudioExt | null {
  const t = (off: number, len: number): string => {
    let s = ''
    for (let i = off; i < off + len && i < header.length; i++) s += String.fromCharCode(header[i])
    return s
  }
  if (t(0, 4) === 'fLaC') return 'flac'
  if (t(0, 4) === 'OggS') return 'ogg'
  if (t(0, 3) === 'ID3') return 'mp3'
  if (header.length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return 'mp3' // MPEG 帧同步
  if (t(0, 4) === 'RIFF' && t(8, 4) === 'WAVE') return 'wav'
  if (t(0, 4) === 'FRM8') return 'dff' // DSDIFF
  if (header.length >= 16 && t(0, 16) === '\x30\x26\xb2\x75\x8e\x66\xcf\x11\xa6\xd9\x00\xaa\x00\x62\xce\x6c') {
    return 'wma'
  }
  if (t(4, 4) === 'ftyp') return t(8, 4) === 'M4A ' ? 'm4a' : 'mp4'
  return null
}