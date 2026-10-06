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
  /** 碟号 → 这张专辑该碟的真实曲目数（cue 完成度判据在主进程按它算，见 AlbumBundle.discTotals）。
   *  渲染侧不读它，但必须原样带回去：漏这一个字段主进程就拿入队曲目数当期望数，
   *  懒加载页只下了前两首也会写出「整张」cue。 */
  discTotals: Record<number, number>
}

export interface UiQueueJob {
  id: string; source: string; state: string; progress: number
  name: string; artist: string; error?: string; downgraded?: boolean; anonFallback?: boolean; outputPath?: string
  /** 主进程实际落档（降级文案回显）；string 而非 UiQuality——IPC 快照不经类型检查 */
  finalQuality?: string
}

/** 「下载整张」的确认文案（QQ 歌曲页与网易云内联页共用一处措辞，见 App.vue / NeteaseTab.vue：
 *  两处各写一遍会漂成两个承诺，而这句话是给用户的契约）。
 *  只在**本页已加载曲目少于整张**时用。必须与主进程的判据一致（AlbumBundle.discTotals）：
 *  残缺批次不产出 album.cue（不是「产出一份只指前几首的 cue」），程序也不会替用户去取没加载的曲目，
 *  补齐的唯一路子是加载完剩余曲目后再点一次。0.7.0 计划稿里那句「.cue 要等整张下齐才生成」
 *  说的像是「稍等就有」，实际是「这批永远没有」——照旧写会把人留在原地等一个不会出现的文件。
 *  用 \n 分行：Electron 的 window.confirm 按纯文本渲染，糊成一长句读不完。 */
export function albumPartialConfirm(album: UiAlbumBundle, loaded: number): string {
  const total = album.totalTracks
  return [
    `《${album.name}》共 ${total} 首，本页当前只加载了 ${loaded} 首（专辑页是滚动懒加载的，没加载的曲目这里不会替你去取）。`,
    `现在下载只会下这 ${loaded} 首：音频与 cover.jpg 照常落进专辑目录，但 album.cue 不会生成。`,
    `cue 要整张 ${total} 首全部下齐才写——只指着 ${loaded} 首的 cue 会让播放器把这张专辑呈现成 ${loaded} 首。`,
    `要拿到 cue：把本页滚到底加载完剩余曲目，再点一次「下载整张」（本页全部已加载曲目会一起重新入队，已下过的会再多落一份）。`,
    '要继续吗？',
  ].join('\n')
}

/** 入队后的回显：整张与残缺两种说法必须不同——残缺那句不写明「这批没有 cue」，
 *  用户就会在专辑目录里找一个根本不会出现的文件。 */
export function albumEnqueuedNotice(album: UiAlbumBundle, loaded: number): string {
  return loaded < album.totalTracks
    ? `已加入 ${loaded} 首（《${album.name}》共 ${album.totalTracks} 首）：这一批不会有 album.cue，加载完剩余曲目后再点一次「下载整张」补齐`
    : `已把整张《${album.name}》${loaded} 首加入下载队列（每碟全部落盘后自动生成本碟 album.cue）`
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