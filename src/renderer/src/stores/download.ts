import { defineStore } from 'pinia'
// 档位并集不再在渲染侧另写一份字面量：UI 侧只留 qualityOptions 一处声明，这里取别名。
// 与主进程 Quality 的同集关系由 tests/renderer-store.test.ts 的类型断言把守（那边同时导入两侧，
// 走 tsc -p tsconfig.json；渲染侧 tsconfig.web 不含 node 类型，直接 import 主进程模块会 TS2591）。
import type { Quality } from '../qualityOptions'

export interface UiTrack {
  id: string; name: string; artist: string; album: string; cover: string
  mediaMid?: string; duration?: number; vip?: boolean
  // 专辑内序号与碟号：仅专辑来源填充。入队时 tracks 原样回传主进程，这里少声明一个字段整张专辑
  // 就会落盘成 N 个 '01 曲名' 互相撞名。字段集与主进程 TrackDTO 的同集关系由 renderer-store 测试把守。
  trackNo?: number; disc?: number
}
export type UiQuality = Quality
export type UiLyricMode = 'both' | 'embed' | 'lrc' | 'none'

/** 专辑批次元数据：渲染侧只持有、整张下载时原样回传 dl:enqueue。
 *  与主进程 AlbumBundle 同形手抄（同 UiTrack 不 import TrackDTO 的理由：渲染工程不含 node 类型，
 *  import 主进程模块会顺着 albumBundle → fsUtils 的 node:path/node:fs 报 TS2307/TS2591），
 *  两侧同集由 tests/renderer-store.test.ts 的 Exactly 断言把守。
 *  字段必须保持纯数据：混进 Set/Map/类实例会让主进程 IPC 出口的 JSON 净化把整包静默变成 undefined。 */
export interface UiAlbumBundle {
  source: 'qq' | 'netease'
  id: string
  name: string
  artist: string
  date: string
  company: string
  coverUrl: string
  totalTracks: number
  discs: number[]
}

export interface UiQueueJob {
  id: string; source: string; state: string; progress: number
  name: string; artist: string; error?: string; downgraded?: boolean; anonFallback?: boolean; outputPath?: string
  /** 主进程实际落档（降级文案回显）；string 而非 UiQuality——IPC 快照不经类型检查 */
  finalQuality?: string
}

export const useDownloadStore = defineStore('download', {
  state: () => ({
    tracks: [] as UiTrack[],
    /** 当前 tracks 的来源（QQ/网易云内联列表互斥显示，防止拿错源下载） */
    trackSource: '' as '' | 'qq' | 'netease',
    selectedIds: new Set<string>(),
    /** 网易云页选中（与 QQ 页分离；底部固定工具栏共用） */
    neSelectedIds: new Set<string>(),
    quality: '320' as UiQuality,
    lyricMode: 'both' as UiLyricMode,
    queue: [] as UiQueueJob[],
    loggedIn: false,
    uin: '',
    neLoggedIn: false,
  }),
  actions: {
    setTracks(t: UiTrack[], source?: 'qq' | 'netease') {
      this.tracks = t
      this.selectedIds = new Set()
      if (source) this.trackSource = source
    },
    /** 懒加载：追加下一批歌曲（保留现有选中） */
    appendTracks(t: UiTrack[]) { this.tracks = [...this.tracks, ...t] },
    toggle(id: string) {
      if (this.selectedIds.has(id)) this.selectedIds.delete(id)
      else this.selectedIds.add(id)
    },
    selectAll() { this.selectedIds = new Set(this.tracks.map((t) => t.id)) },
    clear() { this.selectedIds = new Set() },
    neToggle(id: string) {
      if (this.neSelectedIds.has(id)) this.neSelectedIds.delete(id)
      else this.neSelectedIds.add(id)
    },
    neSelectAll(tracks: { id: string }[]) { this.neSelectedIds = new Set(tracks.map((t) => t.id)) },
    neClear() { this.neSelectedIds = new Set() },
    setQuality(q: UiQuality) { this.quality = q },
    setLyricMode(m: UiLyricMode) { this.lyricMode = m },
    setLogin(ok: boolean, uin: string) { this.loggedIn = ok; this.uin = uin },
    setNeLogin(ok: boolean) { this.neLoggedIn = ok },
    /** 队列事件镜像：主进程推来的 job 快照 → queue 列表（upsert by id）。
     * 顺序即主进程队列顺序：重排队（重试）的任务在主进程是追加到队尾的，
     * 故 failed/done → queued 时移到队尾，而不是原地更新（否则显示顺序与实际执行顺序相反）。 */
    onQueueEvent(job: any) {
      const idx = this.queue.findIndex((q) => q.id === job.id)
      const entry: UiQueueJob = {
        id: job.id, source: job.source ?? 'qq', state: job.state,
        progress: job.progress ?? 0,
        name: job.track?.name ?? '', artist: job.track?.artist ?? '',
        error: job.error, downgraded: job.downgraded, anonFallback: job.anonFallback, outputPath: job.outputPath,
        finalQuality: job.finalQuality,
      }
      if (idx < 0) {
        this.queue.push(entry)
        return
      }
      if (job.state === 'queued' && this.queue[idx].state !== 'queued') {
        this.queue.splice(idx, 1)
        this.queue.push(entry)
        return
      }
      this.queue[idx] = entry
    },
    /** 清除已完成/失败的历史记录（进行中与排队中的保留） */
    clearDone() {
      this.queue = this.queue.filter((q) => q.state === 'queued' || q.state === 'running')
    },
  },
})