import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface DownloadResult { size: number; path: string }

export async function downloadFile(
  url: string,
  dest: string,
  opts: { retries?: number; onProgress?: (got: number, total: number) => void } = {},
): Promise<DownloadResult> {
  const retries = opts.retries ?? 2
  const part = dest + '.part'
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1))
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const body = res.body
      if (!body) throw new Error('空响应体')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const out = fs.createWriteStream(part)
      let got = 0
      const reader = body.getReader()
      const pump: () => Promise<void> = async () => {
        const { done, value } = await reader.read()
        if (done) return
        got += value.byteLength
        out.write(Buffer.from(value))
        opts.onProgress?.(got, total)
        await pump()
      }
      await pump()
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
      const size = fs.statSync(part).size
      if (size === 0) throw new Error('文件为空')
      fs.renameSync(part, dest)
      return { size, path: dest }
    } catch (err) {
      lastErr = err
      if (fs.existsSync(part)) fs.unlinkSync(part)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}