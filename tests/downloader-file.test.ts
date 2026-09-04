import { describe, it, expect } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadFile } from '../src/main/downloader/file'

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
})