// 码率档位表 + 按源过滤规则（纯函数，组件外可直接测：vitest 是 node 环境、无 jsdom，
// .vue 挂不起来，所以规则放这里而不是写组件测试）。
//
// WHY 按源过滤：APE 与 m4a 是 QQ 独有档，网易云没有对应 br。而 settings.json 里的
// quality 是「全局一份」——QQ 侧选过 ape 后切到网易云，选择器照样把 ape 摆出来，
// 用户选了它就静默丢无损（v0.6.1 之前还会每首恒标「已降级」）。
export type Quality = 'flac' | 'ape' | '320' | '128' | 'm4a'
export type QualitySource = 'qq' | 'netease'

const QQ_QUALITIES: Array<{ v: Quality; label: string }> = [
  { v: 'flac', label: '无损' },
  { v: 'ape', label: 'APE' },
  { v: '320', label: '320k' },
  { v: '128', label: '128k' },
  { v: 'm4a', label: 'm4a' },
]
const NE_QUALITIES: Array<{ v: Quality; label: string }> = [
  { v: 'flac', label: '无损' },
  { v: '320', label: '320k' },
  { v: '128', label: '128k' },
]

/** 本源可选档位（顺序即选择器显示顺序） */
export function qualitiesFor(source: QualitySource): Array<{ v: Quality; label: string }> {
  return source === 'netease' ? NE_QUALITIES : QQ_QUALITIES
}

/** 该档位在本源是否存在 */
export function isQualityFor(source: QualitySource, q: Quality): boolean {
  return qualitiesFor(source).some((x) => x.v === q)
}

/** 档位 → 中文名（词表就是 QQ_QUALITIES 这张五档超集，不再另立第二份字面量）。
 *  WHY 容错而不是抛错/返回 undefined：入档来自 IPC 快照（无类型保证），且未走完直链解析时
 *  finalQuality 缺省。未知值回落「低品质」= 0.7.0 之前的整句文案，即退化成旧行为，
 *  绝不把内部枚举名或 "undefined" 甩到用户脸上。 */
export function labelForQuality(q?: string): string {
  return QQ_QUALITIES.find((x) => x.v === q)?.label ?? '低品质'
}
