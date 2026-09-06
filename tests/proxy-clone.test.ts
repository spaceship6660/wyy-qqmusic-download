import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'

// 2026-09-06 实机「An object could not be cloned.」根因回归锚：
// Vue reactive Proxy 不可被结构化克隆（Electron contextBridge/IPC 参数传递用
// structuredClone）——渲染侧必须先把参数 JSON 化再传 invoke。
describe('reactive proxy 与结构化克隆', () => {
  it('reactive 代理直接克隆必然抛 DataCloneError', () => {
    const t = reactive({ id: '1', name: '春日影' })
    expect(() => structuredClone(t)).toThrow(/cloned|clone/i)
  })

  it('JSON 化后克隆成功（渲染侧 api 封装的 clean 语义）', () => {
    const t = reactive({ id: '1', name: '春日影', mediaMid: undefined })
    const cleaned = JSON.parse(JSON.stringify(t)) as { id: string; name: string }
    expect(cleaned).toEqual({ id: '1', name: '春日影' })
    expect(structuredClone(cleaned)).toEqual(cleaned)
  })
})
