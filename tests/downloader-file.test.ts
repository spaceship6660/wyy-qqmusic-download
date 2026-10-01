import { describe, it, expect } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadFile, DownloadHttpError } from '../src/main/downloader/file'

describe('downloadFile', () => {
  it('流式落盘 .part 原子替换；校验大小', async () => {
    const payload = Buffer.from('flac-dummy-bytes'.repeat(100))
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'))
    const dest = path.join(dir, 'out.mp3')
    const { size } = await downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 1 })
    expect(size).toBe(payload.length)
    expect(JSON.stringify(fs.readFileSync(dest))).toBe(JSON.stringify(payload))
    expect(fs.existsSync(dest + '.part')).toBe(false)
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('重试后成功；失败清理 .part', async () => {
    let calls = 0
    const server = http.createServer((_req, res) => {
      calls++
      if (calls === 1) { res.writeHead(500); res.end(); return }
      res.writeHead(200, { 'content-length': '3' }); res.end('abc')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl2-'))
    const dest = path.join(dir, 'out.mp3')
    await downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 1 })
    expect(fs.readFileSync(dest, 'utf-8')).toBe('abc')
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('全部失败时抛错且不留 .part', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(500); res.end() })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl3-'))
    const dest = path.join(dir, 'out.mp3')
    await expect(downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 0 })).rejects.toThrow(/HTTP 500/)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(dest + '.part')).toBe(false)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('流中断后重试成功且无 .part 残留', async () => {
    const payload = Buffer.from('stream-chunk-'.repeat(2000))
    let calls = 0
    const server = http.createServer((_req, res) => {
      calls++
      if (calls === 1) {
        // 第一次：发出半截 payload 后粗暴断开连接（模拟流中断）
        res.writeHead(200, { 'content-length': String(payload.length) })
        res.write(payload.subarray(0, payload.length / 2))
        setTimeout(() => res.destroy(), 20)
        return
      }
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl4-'))
    const dest = path.join(dir, 'out.mp3')
    const { size } = await downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 1 })
    expect(calls).toBe(2)
    expect(size).toBe(payload.length)
    expect(fs.readFileSync(dest)).toEqual(payload)
    expect(fs.existsSync(dest + '.part')).toBe(false)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('0 字节响应视为空文件错误', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '0' })
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl5-'))
    const dest = path.join(dir, 'out.mp3')
    await expect(downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 0 })).rejects.toThrow(/文件为空/)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(dest + '.part')).toBe(false)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('onProgress 递增且最后等于总数', async () => {
    const payload = Buffer.alloc(64 * 1024, 7)
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl6-'))
    const dest = path.join(dir, 'out.mp3')
    const got: number[] = []
    const { size } = await downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, {
      retries: 0,
      onProgress: (g, _t) => got.push(g),
    })
    expect(size).toBe(payload.length)
    expect(got.length).toBeGreaterThan(0)
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeGreaterThan(got[i - 1])
    expect(got[got.length - 1]).toBe(payload.length)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('持续有数据时不因「总时长」超时（超时为无数据间隔）', async () => {
    // 总时长 ~480ms 远超 timeoutMs=150，但每 60ms 有数据 → 必须成功（旧实现按总时长 abort 必挂）
    const payload = Buffer.alloc(32 * 1024, 5)
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(payload.length) })
      let sent = 0
      const chunk = 4096
      const iv = setInterval(() => {
        if (sent >= payload.length) { clearInterval(iv); res.end(); return }
        res.write(payload.subarray(sent, sent + chunk))
        sent += chunk
      }, 60)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl8-'))
    const dest = path.join(dir, 'out.mp3')
    const { size } = await downloadFile(`http://127.0.0.1:${port}/slow.mp3`, dest, { retries: 0, timeoutMs: 150 })
    expect(size).toBe(payload.length)
    expect(fs.readFileSync(dest)).toEqual(payload)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('非 2xx 抛出 DownloadHttpError 且 status 可区分', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end() })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl7-'))
    const dest = path.join(dir, 'out.mp3')
    const err = (await downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, { retries: 0 }).catch((e) => e)) as DownloadHttpError
    expect(err).toBeInstanceOf(DownloadHttpError)
    expect(err.status).toBe(404)
    expect(fs.existsSync(dest)).toBe(false)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('403 → 换 CDN 节点候选重试成功：返回 cdnSwitched=true 且产物完整（不触发 404/重取直链）', async () => {
    // 模拟实测现场：/被拒节点 恒 403，/可用节点 200。两条 URL 除 host 外完全相同。
    const payload = Buffer.from('flac-from-other-node'.repeat(50))
    const requested: string[] = []
    const server = http.createServer((req, res) => {
      requested.push(req.url ?? '')
      if ((req.url ?? '').startsWith('/bad')) { res.writeHead(403); res.end(); return }
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl9-'))
    const dest = path.join(dir, 'out.mp3')
    const r = await downloadFile(`http://127.0.0.1:${port}/bad/a.flac?authSecret=s`, dest, {
      retries: 2,
      altUrls: () => [`http://127.0.0.1:${port}/good/a.flac?authSecret=s`],
    })
    expect(r.cdnSwitched).toBe(true)
    expect(r.size).toBe(payload.length)
    expect(fs.readFileSync(dest)).toEqual(payload)
    expect(fs.existsSync(dest + '.part')).toBe(false)
    expect(requested).toEqual(['/bad/a.flac?authSecret=s', '/good/a.flac?authSecret=s']) // 403 不重试，直接换节点
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('403 且所有候选节点也不可用 → 抛回原始 403（上层 /HTTP 403/ 兜底判据不变）', async () => {
    const requested: string[] = []
    const server = http.createServer((req, res) => {
      requested.push(req.url ?? '')
      res.writeHead(403); res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl10-'))
    const dest = path.join(dir, 'out.mp3')
    const alts = [`http://127.0.0.1:${port}/n1`, `http://127.0.0.1:${port}/n2`]
    const err = (await downloadFile(`http://127.0.0.1:${port}/origin`, dest, {
      retries: 2,
      altUrls: () => alts,
    }).catch((e) => e)) as DownloadHttpError
    expect(err.status).toBe(403)
    expect(err.message).toBe('HTTP 403')
    // 原始 1 次 + 每个候选各 1 次（候选不各自重试，避免 403 场景请求数爆炸）
    expect(requested).toEqual(['/origin', '/n1', '/n2'])
    expect(fs.existsSync(dest)).toBe(false)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })

  it('非 403 失败不触发换节点（候选生成器不被调用）', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(500); res.end() })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as any).port
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl11-'))
    const dest = path.join(dir, 'out.mp3')
    let calls = 0
    await expect(downloadFile(`http://127.0.0.1:${port}/x.mp3`, dest, {
      retries: 0,
      altUrls: () => { calls++; return [] },
    })).rejects.toThrow(/HTTP 500/)
    expect(calls).toBe(0)
    server.close(); fs.rmSync(dir, { recursive: true, force: true })
  })
})