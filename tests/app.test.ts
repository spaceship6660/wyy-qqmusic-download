import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../src/main/app'
import type { App } from '../src/main/app'
import type { TrackDTO } from '../src/main/qqapi/tracks'
import NodeID3 from 'node-id3'

// 主进程装配（T10）集成测试：QQ API 全部 mock（按 URL/body 路由），
// 唯一真实网络 = 本地 http server 供 downloadFile 使用（downloadFile 走全局 fetch）。

const PAYLOAD = fs.readFileSync(path.join(__dirname, 'fixtures', 'mini.mp3')) // 合法 mini.mp3（tagMp3 可写）

function track(id: string, name = '同名', artist = '同歌手'): TrackDTO {
  return { id, name, artist, album: '专辑', cover: '', mediaMid: `MED${id}` }
}

/** 本地下载源：/gone* → 404，其余 → 200 + payload；可延迟响应以制造并发/碰撞窗口 */
async function startServer(delayMs = 0) {
  const recorded: string[] = []
  const server = http.createServer((req, res) => {
    const p = req.url ?? ''
    recorded.push(p)
    if (p.startsWith('/gone')) {
      res.writeHead(404)
      res.end()
      return
    }
    const send = () => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
    }
    if (delayMs > 0) setTimeout(send, delayMs)
    else send()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as any).port as number, recorded }
}

/**
 * QQ API mock：musicu.fcg 按 body.method 路由。
 * - CgiGetVkey：回显请求里的 filename 行（否则 getAudioUrl 会跳过），purl 按
 *   purls 顺序逐次取（第 N 次 vkey 请求用 purls[N]）；默认 purl = filename。
 * - get_song_detail_yqq：默认返回正常 track_info；detailBroken 时返回缺 data 的坏形状
 *   （postMusicu 路径缺失 → QqApiError）。
 */
function makeFetchImpl(opts: { port: number; purls?: string[]; detailBroken?: boolean }) {
  let vkeyCalls = 0
  return vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('musicu.fcg')) {
      const body = JSON.parse(String(init?.body)) as any
      if (body.req_1?.method === 'CgiGetVkey') {
        const purls = opts.purls ?? []
        const purl = purls[Math.min(vkeyCalls, Math.max(0, purls.length - 1))] ?? ''
        vkeyCalls++
        const songmid = body.req_1?.param?.songmid?.[0] ?? 'M'
        const filenames: string[] = body.req_1?.param?.filename ?? ['M800X.mp3']
        return new Response(
          JSON.stringify({
            req_1: {
              code: 0,
              data: {
                sip: [`http://127.0.0.1:${opts.port}/`],
                midurlinfo: filenames.map((filename) => ({ songmid, filename, purl: purl || filename })),
              },
            },
          }),
          { status: 200 },
        )
      }
      if (body.info?.method === 'get_song_detail_yqq') {
        if (opts.detailBroken) return new Response(JSON.stringify({ info: { code: 0 } }), { status: 200 })
        return new Response(
          JSON.stringify({
            info: {
              data: {
                track_info: {
                  mid: 'M', title: 'T', time_public: '2020-01-01',
                  singer: [{ name: 'X' }], album: { name: 'A' },
                  file: { media_mid: 'MED' }, flags: {},
                },
              },
            },
          }),
          { status: 200 },
        )
      }
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
}

interface Env {
  app: App
  dir: string     // userDataDir
  dl: string      // 下载目录
  server: http.Server
  recorded: string[]   // 下载源实际收到的路径
  events: { start: number; done: number; failed: number; active: number; peak: number; donePaths: string[] }
}

const envs: Env[] = []

afterEach(() => {
  for (const e of envs.splice(0)) {
    e.server.close()
    fs.rmSync(e.dir, { recursive: true, force: true })
  }
})

async function makeEnv(opts: { concurrency?: number; delayMs?: number; detailBroken?: boolean; purls?: string[] } = {}): Promise<Env> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-t10-'))
  const dl = path.join(dir, 'dl')
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ concurrency: opts.concurrency ?? 2, downloadDir: dl, lyricMode: 'none' }),
  )
  const { server, port, recorded } = await startServer(opts.delayMs ?? 0)
  const fetchImpl = makeFetchImpl({ port, purls: opts.purls, detailBroken: opts.detailBroken })
  const events = { start: 0, done: 0, failed: 0, active: 0, peak: 0, donePaths: [] as string[] }
  const app = createApp({
    userDataDir: dir,
    fetchImpl,
    emitEvent: (ch, payload) => {
      const p = payload as { outputPath?: string }
      if (ch === 'dl:jobStart') {
        events.start++
        events.active++
        events.peak = Math.max(events.peak, events.active)
      }
      if (ch === 'dl:done') {
        events.done++
        events.active--
        if (p.outputPath) events.donePaths.push(p.outputPath)
      }
      if (ch === 'dl:failed') {
        events.failed++
        events.active--
      }
    },
  })
  const env: Env = { app, dir, dl, server, recorded, events }
  envs.push(env)
  return env
}

async function waitFor(cond: () => boolean, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('createApp runner 装配（T10 评审修复）', () => {
  it('C1: 并发同名任务 → dest 互不相同且文件完整，无 .part 残留', async () => {
    // 慢速下载源（~1.2s）：第二个任务启动时（限速器间隔 1s）第一个仍在写 .part，
    // 复现「check-then-write 撞同名 .part」场景；占位文件修复后二者各得其所。
    const env = await makeEnv({ delayMs: 1200 })
    env.app.enqueue([track('a', '歌', '手'), track('b', '歌', '手')], '320')
    await waitFor(() => env.events.done >= 2)
    expect(env.events.failed).toBe(0)
    expect(env.events.donePaths.length).toBe(2)
    expect(new Set(env.events.donePaths).size).toBe(2) // dest 互不相同

    const files = fs.readdirSync(env.dl)
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]) // 无 .part 残留
    const mp3s = files.filter((f) => f.endsWith('.mp3'))
    expect(mp3s.length).toBe(2)
    // 完整性：两份下载+标签互逐字节一致（任一 .part 撞坏/半截都会不等），
    // 且标签已内嵌（下载文件经 tagFile 后附 ID3 帧，长度大于原始 payload）
    const bufs = mp3s.map((f) => fs.readFileSync(path.join(env.dl, f)))
    expect(bufs[0].equals(bufs[1])).toBe(true)
    expect(bufs[0].length).toBeGreaterThan(PAYLOAD.length)
    expect((NodeID3.read(path.join(env.dl, mp3s[0])) as any).title).toBe('歌')
    expect((NodeID3.read(path.join(env.dl, mp3s[1])) as any).title).toBe('歌')
  })

  it('I2: 404 直链 → 重取直链再下成功（404 不白等重试）', async () => {
    // 第一次 vkey 给出的直链 404，第二次 200；断言下载源恰好收到两次请求
    const env = await makeEnv({ purls: ['gone.mp3', 'ok.mp3'] })
    env.app.enqueue([track('x', '直链歌')], '320')
    await waitFor(() => env.events.done >= 1)
    expect(env.events.failed).toBe(0)
    expect(env.recorded).toEqual(['/gone.mp3', '/ok.mp3']) // 无 3 次×退避重试
    const files = fs.readdirSync(env.dl).filter((f) => f.endsWith('.mp3'))
    expect(files.length).toBe(1)
    const out = fs.readFileSync(path.join(env.dl, files[0]))
    expect(out.length).toBeGreaterThan(PAYLOAD.length) // 下载成功并经标签内嵌
    expect((NodeID3.read(path.join(env.dl, files[0])) as any).title).toBe('直链歌')
  })

  it('I7: 标签失败 → jobFailed 且已下载文件被清理', async () => {
    const env = await makeEnv({ detailBroken: true })
    env.app.enqueue([track('y')], '320')
    await waitFor(() => env.events.failed >= 1)
    expect(env.events.done).toBe(0)
    expect(fs.readdirSync(env.dl)).toEqual([]) // 占位/下载文件/.lrc 全部清理
  })

  it('I4: settingsSet 并发生效，新批次按新并发调度', async () => {
    const env = await makeEnv({ concurrency: 1, delayMs: 1500 })
    env.app.enqueue([track('a'), track('b')], '320')
    await waitFor(() => env.events.done >= 2)
    expect(env.events.peak).toBe(1) // 并发 1：活跃峰值 1
    env.app.settingsSet({ concurrency: 3 })
    expect(env.app.settingsGet().concurrency).toBe(3)
    env.app.enqueue([track('c'), track('d')], '320')
    await waitFor(() => env.events.done >= 4)
    expect(env.events.peak).toBe(2) // 新并发下两任务重叠
  })

  it('enqueue 同次入队同 id 去重（只启一个任务）', async () => {
    const env = await makeEnv()
    const t = track('z')
    env.app.enqueue([t, { ...t, name: '同名副本' }], '320')
    await waitFor(() => env.events.done >= 1)
    await new Promise((r) => setTimeout(r, 1600)) // 越过限速窗口，确认无第二个任务启动
    expect(env.events.failed).toBe(0)
    expect(env.events.start).toBe(1)
    expect(env.events.donePaths.length).toBe(1)
  })
})