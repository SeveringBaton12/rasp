import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const element = () => ({ addEventListener() {}, innerHTML: '', value: '', hidden: false, setAttribute() {}, removeAttribute() {} })
const storage = new Map()
const context = vm.createContext({
  document: { querySelectorAll: () => [], getElementById: element, addEventListener() {}, documentElement: { dataset: {} } },
  window: { addEventListener() {}, scrollTo() {}, scrollY: 0 },
  location: { hash: '#/g/A' }, navigator: { onLine: true },
  localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
  Intl, Date, console, matchMedia: () => ({ matches: false }), clearInterval() {}, setInterval() {},
})
const source = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8')
vm.runInContext(source.slice(0, source.indexOf("window.addEventListener('hashchange'")), context)
vm.runInContext(`
  const oldLesson = { d: '2026-11-16', n: 1, s: '08:30', room: '101', subj: 'Physics' }
  const moved = { ...oldLesson, room: '202' }
  const changes = changesBetween([oldLesson], [moved])
  if (changes.added.length !== 1 || changes.removed.length !== 1) throw Error('Room change lost')
  if (changesBetween([oldLesson], [{...oldLesson}]).added.length) throw Error('False change')
  index = { groups: [{id:'g',name:'АД-241'}], teachers: [{id:'t',name:'Семёнов И.И.'}], rooms: [] }
  if (matches('ад241').g.length !== 1) throw Error('Compact group search failed')
  if (matches('семенов').t.length !== 1) throw Error('Ё normalization failed')
  index = { generated: 'x', synced: new Date().toISOString() }
  refreshIndex = false
  var requests = {}; var screens = []
  getJson = path => new Promise(resolve => requests[path] = resolve)
  renderSchedule = (kind, data) => screens.push(data.id)
`, context)
const first = context.route()
context.location.hash = '#/g/B'
const second = context.route()
context.requests['data/g/B.json']({ id: 'B' })
await second
context.requests['data/g/A.json']({ id: 'A' })
await first
assert.deepEqual(Array.from(context.screens), ['B'])
assert.ok(!vm.runInContext('app.innerHTML', context).includes('class="error"'))
console.log('PASS: changed rooms, unchanged lessons, normalized search, overlapping navigation')
