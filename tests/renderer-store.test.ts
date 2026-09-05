import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDownloadStore } from '../src/renderer/src/stores/download'

describe('download store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('勾选/全选/清空/当前质量', () => {
    const s = useDownloadStore()
    s.setTracks([
      { id: 'a', name: 'A', artist: 'X', album: '', cover: '', vip: true },
      { id: 'b', name: 'B', artist: 'Y', album: '', cover: '' },
    ])
    expect(s.selectedIds.size).toBe(0)
    s.toggle('a'); expect(s.selectedIds.has('a')).toBe(true)
    s.selectAll(); expect(s.selectedIds.size).toBe(2)
    s.clear(); expect(s.selectedIds.size).toBe(0)
    expect(s.quality).toBe('320')
    s.setQuality('flac'); expect(s.quality).toBe('flac')
  })

  it('setQuality 联动契约：码率单一事实源（store 侧）', () => {
    const s = useDownloadStore()
    expect(s.quality).toBe('320')
    s.setQuality('flac')
    expect(s.quality).toBe('flac')
  })

  it('队列事件镜像：jobStart/progress/done/failed 更新 queue 列表', () => {
    const s = useDownloadStore()
    s.onQueueEvent({ id: 'j1', source: 'qq', state: 'running', progress: 10 } as any)
    expect(s.queue[0].state).toBe('running')
    s.onQueueEvent({ id: 'j1', source: 'qq', state: 'done', progress: 100, outputPath: '/x.mp3' } as any)
    expect(s.queue[0].state).toBe('done')
  })
})