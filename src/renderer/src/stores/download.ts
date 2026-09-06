import { defineStore } from 'pinia'

export interface UiTrack {
  id: string; name: string; artist: string; album: string; cover: string
  mediaMid?: string; duration?: number; vip?: boolean
}
export type UiQuality = 'flac' | 'ape' | '320' | '128' | 'm4a'
export type UiLyricMode = 'both' | 'embed' | 'lrc' | 'none'

export interface UiQueueJob {
  id: string; source: string; state: string; progress: number
  name: string; artist: string; error?: string; downgraded?: boolean; outputPath?: string
}

export const useDownloadStore = defineStore('download', {
  state: () => ({
    tracks: [] as UiTrack[],
    selectedIds: new Set<string>(),
    quality: '320' as UiQuality,
    lyricMode: 'both' as UiLyricMode,
    queue: [] as UiQueueJob[],
    loggedIn: false,
    uin: '',
  }),
  actions: {
    setTracks(t: UiTrack[]) { this.tracks = t; this.selectedIds = new Set() },
    toggle(id: string) {
      if (this.selectedIds.has(id)) this.selectedIds.delete(id)
      else this.selectedIds.add(id)
    },
    selectAll() { this.selectedIds = new Set(this.tracks.map((t) => t.id)) },
    clear() { this.selectedIds = new Set() },
    setQuality(q: UiQuality) { this.quality = q },
    setLyricMode(m: UiLyricMode) { this.lyricMode = m },
    setLogin(ok: boolean, uin: string) { this.loggedIn = ok; this.uin = uin },
    /** 队列事件镜像：主进程推来的 job 快照 → queue 列表（upsert by id） */
    onQueueEvent(job: any) {
      const idx = this.queue.findIndex((q) => q.id === job.id)
      const entry: UiQueueJob = {
        id: job.id, source: job.source ?? 'qq', state: job.state,
        progress: job.progress ?? 0,
        name: job.track?.name ?? '', artist: job.track?.artist ?? '',
        error: job.error, downgraded: job.downgraded, outputPath: job.outputPath,
      }
      if (idx >= 0) this.queue[idx] = entry
      else this.queue.push(entry)
    },
    /** 清除已完成/失败的历史记录（进行中与排队中的保留） */
    clearDone() {
      this.queue = this.queue.filter((q) => q.state === 'queued' || q.state === 'running')
    },
  },
})