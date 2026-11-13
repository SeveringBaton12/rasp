'use strict'

const app = document.getElementById('app')
const foot = document.getElementById('foot')
const input = document.getElementById('q')
const results = document.getElementById('results')

const KINDS = { g: 'Группы', t: 'Преподаватели', r: 'Аудитории' }
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const DAYS_FULL = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const STALE_AFTER_HOURS = 30
// The university's bell schedule; a lesson's own times win when it has them
const PAIRS = { 1: ['08:30', '10:05'], 2: ['10:25', '12:00'], 3: ['12:30', '14:05'], 4: ['14:20', '15:55'], 5: ['16:05', '17:40'], 6: ['17:50', '19:25'], 7: ['19:35', '21:10'] }
// Pairs shown even when the week has nothing that late
const MIN_PAIRS = 4

const ICONS = {
  star: '<svg viewBox="0 0 24 24"><path d="m12 3.5 2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.3 9.9l6-.9z"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
}

let index = null
let timer = null
let routeVersion = 0
let refreshIndex = true
let offline = !navigator.onLine
const views = new Map()

// ---------- small helpers ----------

const esc = value =>
  String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem('rasp.' + key))
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem('rasp.' + key)
      else localStorage.setItem('rasp.' + key, JSON.stringify(value))
    } catch {
      // Storage is off (private window): the page works, it just forgets
    }
  },
}

const pad = n => String(n).padStart(2, '0')
const toDate = iso => new Date(iso + 'T00:00:00Z')
const toIso = date => date.toISOString().slice(0, 10)
const addDays = (iso, n) => toIso(new Date(toDate(iso).getTime() + n * 86400000))
const weekday = iso => toDate(iso).getUTCDay()
const mondayOf = iso => addDays(iso, -((weekday(iso) + 6) % 7))
const minutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))
const dayMonth = iso => `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`
const shortDate = iso => `${iso.slice(8)}.${iso.slice(5, 7)}`

// The university's clock, whatever the visitor's own time zone is
function minskNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map(part => [part.type, part.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

function plural(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many
}

function span(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m} мин`
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`
}

function lessonKey(lesson) {
  return JSON.stringify([lesson.d, lesson.n, lesson.s, lesson.e, lesson.subj,
    lesson.type, lesson.teacher, lesson.room, lesson.sub, lesson.groups])
}

function changesBetween(before, after) {
  const old = new Set(before.map(lessonKey))
  const next = new Set(after.map(lessonKey))
  return { added: after.filter(l => !old.has(lessonKey(l))), removed: before.filter(l => !next.has(lessonKey(l))) }
}

async function getJson(path, signal) {
  const cached = store.get('cache:' + path)
  try {
    const response = await fetch(path, { cache: 'no-cache', signal })
    if (!response.ok) throw new Error(`${path}: ${response.status}`)
    const data = await response.json()
    offline = response.headers.get('X-Rasp-Offline') === 'true' || !navigator.onLine
    const changes = cached?.data?.lessons && data.lessons
      ? changesBetween(cached.data.lessons, data.lessons) : null
    if (!offline) {
      if (changes && (changes.added.length || changes.removed.length))
        store.set('changes:' + path, { ...changes, at: Date.now() })
      store.set('cache:' + path, { data, at: Date.now() })
    }
    return data
  } catch (error) {
    if (error.name === 'AbortError') throw error
    if (cached && !/: 404$/.test(error.message)) {
      offline = true
      return cached.data
    }
    throw error
  }
}

function changesHtml(kind, data) {
  const changes = store.get(`changes:data/${kind}/${encodeURIComponent(data.id)}.json`)
  if (!changes || Date.now() - changes.at > 7 * 86400000) return ''
  const relevant = list => list.filter(l => l.d >= minskNow().date)
  const added = relevant(changes.added)
  const removed = relevant(changes.removed)
  if (!added.length && !removed.length) return ''
  const rows = (list, label) => list.map(l => `<li><span>${label}</span> ${esc(shortDate(l.d))} · ${esc(l.s)} · ${esc(l.subj)}${l.room ? ' · ' + esc(l.room) : ''}</li>`).join('')
  return `<details class="changes"><summary>Есть изменения <span>+${added.length} / −${removed.length}</span></summary>
    <p>По сравнению с расписанием, которое вы открывали раньше. Перенос показан как отмена и новое занятие.</p>
    <ul>${rows(added, 'Добавлено')}${rows(removed, 'Убрано')}</ul></details>`
}

const link = (kind, id, label) => `<a href="#/${kind}/${encodeURIComponent(id)}">${esc(label)}</a>`

// Short, interruptible animations; native controls still work without JavaScript motion.
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function animateContent(target = app) {
  if (!target || reduceMotion() || !target.animate) return
  target.animate([
    { opacity: 0, transform: 'translateY(6px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration: 220, easing: 'cubic-bezier(.2,.7,.3,1)' })
}

function animateDetails(section) {
  const summary = section.querySelector('summary')
  if (!summary) return
  let animation = null
  let expanded = section.open
  summary.addEventListener('click', event => {
    if (reduceMotion() || !section.animate) return
    event.preventDefault()
    expanded = animation ? !expanded : !section.open
    const start = section.getBoundingClientRect().height
    if (animation) animation.cancel()
    section.dataset.animating = 'true'
    section.dataset.expanded = String(expanded)
    section.style.height = ''
    section.open = true
    const style = getComputedStyle(section)
    const edges = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const end = expanded ? section.scrollHeight + edges : summary.offsetHeight + padding + edges
    section.style.overflow = 'hidden'
    section.style.height = start + 'px'
    animation = section.animate({ height: [start + 'px', end + 'px'] }, {
      duration: 240, easing: 'cubic-bezier(.2,.7,.3,1)',
    })
    animation.onfinish = () => {
      section.open = expanded
      section.style.height = ''
      section.style.overflow = ''
      delete section.dataset.animating
      delete section.dataset.expanded
      animation = null
      section.dispatchEvent(new Event('toggle'))
    }
  })
}

// ---------- search ----------

function matches(query) {
  const words = query.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const hit = name => {
    const plain = name.toLowerCase().replace(/ё/g, 'е')
    const tight = plain.replace(/[\s.,-]/g, '')
    return words.every(word => plain.includes(word) || tight.includes(word.replace(/[\s.,-]/g, '')))
  }
  const rank = name => (name.toLowerCase().startsWith(words[0]) ? 0 : 1)
  const pick = list => list.filter(item => hit(item.name)).sort((a, b) => rank(a.name) - rank(b.name)).slice(0, 8)
  return { g: pick(index.groups), t: pick(index.teachers), r: pick(index.rooms) }
}

function hideResults() {
  results.hidden = true
  input.setAttribute('aria-expanded', 'false')
  input.removeAttribute('aria-activedescendant')
}

function showResults() {
  const found = index && matches(input.value)
  if (!found) {
    hideResults()
    return
  }
  let html = ''
  for (const kind of ['g', 't', 'r']) {
    if (found[kind].length === 0) continue
    html += `<h4>${KINDS[kind]}</h4>`
    for (const [position, item] of found[kind].entries()) {
      const hint = kind === 'g' ? item.faculty : kind === 't' ? item.position : ''
      html += `<a id="result-${kind}-${position}" role="option" aria-selected="false" href="#/${kind}/${encodeURIComponent(item.id)}"><span>${esc(item.name)}</span><small>${esc(hint)}</small></a>`
    }
  }
  results.innerHTML = html || '<div class="none">Ничего не найдено</div>'
  results.hidden = false
  input.setAttribute('aria-expanded', 'true')
  input.removeAttribute('aria-activedescendant')
}

input.addEventListener('input', showResults)
input.addEventListener('focus', showResults)
input.addEventListener('keydown', event => {
  if (results.hidden) return
  const items = [...results.querySelectorAll('a')]
  const at = items.findIndex(item => item.classList.contains('on'))
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (items.length === 0) return
    const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
      : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items.forEach((item, i) => {
      item.classList.toggle('on', i === next)
      item.setAttribute('aria-selected', String(i === next))
    })
    input.setAttribute('aria-activedescendant', items[next].id)
    items[next].scrollIntoView({ block: 'nearest' })
  } else if (event.key === 'Enter') {
    const target = items[at] ?? items[0]
    if (target) location.hash = target.getAttribute('href')
  } else if (event.key === 'Escape') {
    input.blur()
    hideResults()
  }
})
document.addEventListener('click', event => {
  if (!event.target.closest('.search') || event.target.closest('.results a')) hideResults()
})

// ---------- theme ----------

document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement
  const isDark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  root.dataset.theme = isDark ? 'light' : 'dark'
  try {
    localStorage.setItem('rasp.theme', root.dataset.theme)
  } catch {
    // Not kept without storage
  }
})

// ---------- home ----------

function renderHome(tab) {
  document.body.dataset.page = 'home'
  document.title = 'Все расписания · пары. БРУ'
  const mine = store.get('my')
  const tabs = [['full', 'Дневная форма'], ['part', 'Заочная форма'], ['t', 'Преподаватели'], ['r', 'Аудитории']]
  let body = ''
  if (tab === 't') {
    body = `<div class="people">${index.teachers
      .map(t => `<a href="#/t/${encodeURIComponent(t.id)}">${esc(t.name)}<small>${esc(t.position || ' ')}</small></a>`)
      .join('')}</div>`
  } else if (tab === 'r') {
    const buildings = new Map()
    for (const room of index.rooms) {
      const building = room.name.split(',')[0]
      if (!buildings.has(building)) buildings.set(building, [])
      buildings.get(building).push(room)
    }
    body = [...buildings]
      .map(
        ([building, rooms]) =>
          `<details class="faculty" data-section="${esc(building)}"><summary><span>${esc(building)}</span><small>${rooms.length} ${plural(rooms.length, 'аудитория', 'аудитории', 'аудиторий')}</small><i aria-hidden="true"></i></summary><div class="faculty-content"><div class="chips">${rooms
            .map(r => `<a class="chip" href="#/r/${encodeURIComponent(r.id)}">${esc(r.name.split(',').slice(1).join(',').replace('ауд.', '').trim() || r.name)}</a>`)
            .join('')}</div></div></details>`,
      )
      .join('')
  } else {
    const faculties = new Map()
    for (const group of index.groups.filter(g => g.form === tab)) {
      if (!faculties.has(group.faculty)) faculties.set(group.faculty, new Map())
      const courses = faculties.get(group.faculty)
      if (!courses.has(group.course)) courses.set(group.course, [])
      courses.get(group.course).push(group)
    }
    body = [...faculties]
      .sort(([a], [b]) => a.localeCompare(b, 'ru'))
      .map(
        ([faculty, courses]) =>
          `<details class="faculty" data-section="${esc(faculty)}"><summary><span>${esc(faculty)}</span><small>${[...courses.values()].reduce((total, groups) => total + groups.length, 0)} ${plural([...courses.values()].reduce((total, groups) => total + groups.length, 0), 'группа', 'группы', 'групп')}</small><i aria-hidden="true"></i></summary><div class="faculty-content">${[...courses]
            .sort(([a], [b]) => a.localeCompare(b, 'ru'))
            .map(
              ([course, groups]) =>
                `<div class="course"><span>${esc(course)}</span><div class="chips">${groups
                  .map(g => `<a class="chip" href="#/g/${encodeURIComponent(g.id)}">${esc(g.name)}</a>`)
                  .join('')}</div></div>`,
            )
            .join('')}</div></details>`,
      )
      .join('')
  }
  const saved = mine && (mine.kind === 'g' ? index.groups : index.teachers).find(item => item.id === mine.id)
  app.innerHTML = `
    <div class="hello catalog-header">
      <div><h1>Расписание занятий</h1><p>Группы, преподаватели и аудитории БРУ</p></div>
      ${saved ? `<a class="favorite-shortcut" href="#/${mine.kind}/${encodeURIComponent(mine.id)}">${ICONS.star}<span>Сохранённое расписание <b>${esc(saved.name)}</b></span></a>` : `<span class="catalog-count">${index.groups.length} групп · ${index.teachers.length} преподавателей</span>`}
    </div>
    <div class="tabs" role="tablist">${tabs
      .map(([id, label]) => `<button class="tab" role="tab" aria-selected="${id === tab}" data-tab="${id}">${label}</button>`)
      .join('')}</div>
    <div class="directory-body">${body}</div>`
  const sectionKey = 'sections:' + tab
  const openSections = new Set(store.get(sectionKey) || [])
  app.querySelectorAll('details.faculty').forEach(section => {
    section.open = openSections.has(section.dataset.section)
    animateDetails(section)
    section.addEventListener('toggle', () => {
      if (section.dataset.animating) return
      if (section.open) openSections.add(section.dataset.section)
      else openSections.delete(section.dataset.section)
      store.set(sectionKey, [...openSections])
    })
  })
  app.querySelectorAll('[data-tab]').forEach(button =>
    button.addEventListener('click', () => {
      location.hash = '#/all/' + button.dataset.tab
    }),
  )
}

// ---------- schedule ----------

function lessonHtml(kind, lesson, state) {
  let who = ''
  if (kind === 'g') {
    if (lesson.teacher) who += `<span>${lesson.tid ? link('t', lesson.tid, lesson.teacher) : esc(lesson.teacher)}</span>`
    if (lesson.room) who += `<span class="room">${lesson.rid ? link('r', lesson.rid, lesson.room) : esc(lesson.room)}</span>`
  } else if (kind === 't') {
    const names = lesson.groups.split(',').map(name => name.trim()).filter(Boolean)
    who += `<span>${names
      .map(name => {
        const group = index.groups.find(g => g.name === name)
        return group ? link('g', group.id, name) : esc(name)
      })
      .join(', ')}</span>`
    if (lesson.room) who += `<span class="room">${lesson.rid ? link('r', lesson.rid, lesson.room) : esc(lesson.room)}</span>`
  } else {
    if (lesson.teacher) who += `<span>${lesson.tid ? link('t', lesson.tid, lesson.teacher) : esc(lesson.teacher)}</span>`
    who += `<span>${lesson.groups
      .map(tag => {
        const group = index.groups.find(g => g.name === tag || tag.startsWith(g.name + '-'))
        return group ? link('g', group.id, tag) : esc(tag)
      })
      .join(', ')}</span>`
  }
  const sub = kind !== 'r' && lesson.sub ? ` <em>· ${esc(kind === 'g' ? 'подгруппа ' + lesson.sub.split('-').pop() : lesson.sub)}</em>` : ''
  return `<div class="lesson t-${esc(lesson.type)} ${state}" data-date="${esc(lesson.d)}" data-start="${esc(lesson.s)}" data-end="${esc(lesson.e)}">
    <div class="subj">${esc(lesson.subj)}${state.includes('changed') ? '<small class="change-badge">Новое / изменено</small>' : ''}</div><div class="kind">${esc(lesson.label)}${sub}</div><div class="who">${who}</div>
  </div>`
}

function nowCard(kind, lessons) {
  const now = minskNow()
  const current = lessons.filter(l => l.d === now.date && minutes(l.s) <= now.minutes && now.minutes < minutes(l.e))
  const next = lessons.find(l => l.d > now.date || (l.d === now.date && minutes(l.s) > now.minutes))
  if (current.length === 0 && !next) return ''
  const place = lesson => [kind === 't' ? lesson.sub || lesson.groups : lesson.teacher, lesson.room].filter(Boolean).join(' · ')
  let html = ''
  for (const lesson of current) {
    const total = minutes(lesson.e) - minutes(lesson.s)
    const done = now.minutes - minutes(lesson.s)
    html += `<div class="nowrow"><span class="nowlabel cur">Сейчас</span>
      <span class="nowwhat">${esc(lesson.subj)}<small>${esc(lesson.label)} · ${esc(place(lesson))}</small></span>
      <span class="nowwhen">до ${lesson.e} · ещё ${span(total - done)}</span></div>
      <div class="bar"><i style="width:${Math.round((done / total) * 100)}%"></i></div>`
  }
  if (next) {
    const days = Math.round((toDate(next.d) - toDate(now.date)) / 86400000)
    const when =
      days === 0
        ? `в ${next.s} · через ${span(minutes(next.s) - now.minutes)}`
        : days === 1
          ? `завтра в ${next.s}`
          : `${DAYS[weekday(next.d)]}, ${dayMonth(next.d)} в ${next.s}`
    html += `<div class="nowrow"><span class="nowlabel">Далее</span>
      <span class="nowwhat">${esc(next.subj)}<small>${esc(next.label)} · ${esc(place(next))}</small></span>
      <span class="nowwhen">${when}</span></div>`
  }
  return `<div class="nowcard ${current.length ? 'live' : ''}"><div class="nowcard-icon" aria-hidden="true">↗</div><div class="nowcard-content">${html}</div></div>`
}

function renderSchedule(kind, data, view) {
  document.body.dataset.page = 'schedule'
  views.set(`${kind}/${data.id}`, view)
  const now = minskNow()
  const mine = store.get('my')
  const isMine = mine && mine.kind === kind && mine.id === data.id
  const recentChanges = store.get(`changes:data/${kind}/${encodeURIComponent(data.id)}.json`)
  const changedKeys = new Set(recentChanges && Date.now() - recentChanges.at < 7 * 86400000 ? recentChanges.added.map(lessonKey) : [])
  const lessons = [...data.lessons]
    .sort((a, b) => (a.d + a.s).localeCompare(b.d + b.s) || (a.sub ?? '').localeCompare(b.sub ?? ''))

  // Weeks the data covers
  const first = data.period?.[0] ?? lessons[0]?.d ?? now.date
  const last = data.period?.[1] ?? lessons.at(-1)?.d ?? now.date
  const weeks = []
  for (let monday = mondayOf(first); monday <= last; monday = addDays(monday, 7)) weeks.push(monday)

  const thisMonday = mondayOf(now.date)
  if (!weeks.includes(thisMonday)) { weeks.push(thisMonday); weeks.sort() }

  const upcoming = lessons.find(l => l.d >= now.date)?.d
  const anchor = first <= now.date && now.date <= last ? now.date : upcoming ?? first
  if (!view.week || !weeks.includes(view.week)) view.week = weeks.includes(mondayOf(anchor)) ? mondayOf(anchor) : weeks[0]
  const days = []
  for (let i = 0; i < 7; i++) {
    const date = addDays(view.week, i)
    const list = lessons.filter(l => l.d === date)
    if (i < 6 || list.length > 0 || date === now.date || date === view.day) days.push({ date, list })
  }
  if (!view.day || !days.some(day => day.date === view.day)) {
    // Today, or after today's last pair the next day that has lessons
    const todayLeft = lessons.some(l => l.d === now.date && minutes(l.e) > now.minutes)
    const want = days.find(day => day.date === now.date) ?? days.find(day => day.list.length > 0 && (day.date > now.date || (day.date === now.date && todayLeft)))
    view.day = (want ?? days.find(day => day.list.length > 0) ?? days[0]).date
  }

  const meta =
    kind === 'g'
      ? [data.faculty, data.course, data.form === 'part' ? 'заочная форма' : ''].filter(Boolean).join(' · ')
      : kind === 't'
        ? data.position
        : 'Аудитория'
  const at = weeks.indexOf(view.week)
  const weekEnd = addDays(view.week, 6)
  const checked = index.checked || index.synced
  const stale = checked && (Date.now() - Date.parse(checked)) / 3600000 > STALE_AFTER_HOURS

  // Every pair of the day has its row, an empty one too, as on the official site
  const lastPair = Math.max(MIN_PAIRS, ...days.flatMap(day => day.list.map(l => l.n)))
  const times = {}
  for (const lesson of lessons) times[lesson.n] ??= [lesson.s, lesson.e]
  const timeOf = n => times[n] ?? PAIRS[n] ?? ['', '']
  const pairLabel = n => `<b>${n}</b><span>пара</span><small>${timeOf(n)[0]}<br>${timeOf(n)[1]}</small>`

  let grid = '<div class="corner"></div>'
  for (let n = 1; n <= lastPair; n++) grid += `<div class="ph" style="grid-row:${n + 1}">${pairLabel(n)}</div>`
  days.forEach(({ date, list }, i) => {
    const marks = `${date === now.date ? 'today' : ''} ${date === view.day ? 'sel' : ''}`
    grid += `<div class="dh ${marks}" style="grid-column:${i + 2}"><span class="day-name">${DAYS[weekday(date)]}</span><b>${Number(date.slice(8))}</b><small>${MONTHS[Number(date.slice(5, 7)) - 1]}</small>${date === now.date ? '<i class="today-dot"></i>' : ''}</div>`
    for (let n = 1; n <= lastPair; n++) {
      const here = list.filter(l => l.n === n)
      const [start, end] = timeOf(n)
      const isPast = date < now.date || (date === now.date && end && minutes(end) <= now.minutes)
      const isLive = date === now.date && start && minutes(start) <= now.minutes && !isPast
      const body = here.map(l => lessonHtml(kind, l, `${isPast ? 'past' : isLive ? 'live' : ''} ${changedKeys.has(lessonKey(l)) ? 'changed' : ''}`)).join('')
      grid += `<div class="cell ${marks} ${here.length ? '' : 'empty'}" style="grid-column:${i + 2};grid-row:${n + 1}">
        <div class="num">${pairLabel(n)}</div>
        <div class="stack">${body || '<span class="none">нет пары</span>'}</div></div>`
    }
  })

  document.title = `${data.name} — расписание БРУ`
  app.innerHTML = `
    ${offline ? `<div class="note offline">Вы офлайн · сохранённое расписание. Обновлено ${esc(new Date(index.synced).toLocaleString('ru-RU'))}.</div>` : ''}
    ${stale && !offline ? `<div class="note">Давно не удавалось проверить источник (последний раз ${new Date(checked).toLocaleString('ru-RU')}). Сверьтесь с <a href="${esc(data.source ?? 'https://rasp.bru.by/')}" rel="noopener">официальным сайтом</a>.</div>` : ''}
    <div class="head">
      <div><div class="eyebrow">${kind === 'g' ? 'РАСПИСАНИЕ ГРУППЫ' : kind === 't' ? 'РАСПИСАНИЕ ПРЕПОДАВАТЕЛЯ' : 'ЗАНЯТОСТЬ АУДИТОРИИ'}</div><h1>${esc(data.name)}</h1><div class="meta">${esc(meta)}</div></div>
      <div class="actions">
        ${kind !== 'r' ? `<button title="Запомнить расписание" aria-label="Запомнить расписание" class="btn ${isMine ? 'on' : ''}" id="mine" aria-pressed="${Boolean(isMine)}">${ICONS.star}<span>${isMine ? 'В избранном' : 'Запомнить'}</span></button>` : ''}
        <a class="btn" href="#/all" aria-label="На главную" title="На главную">${ICONS.home}<span>На главную</span></a>
      </div>
    </div>
    ${changesHtml(kind, data)}
    <div id="now">${nowCard(kind, lessons)}</div>
    <div class="schedule-section-title"><h2>Расписание занятий</h2><div class="schedule-legend"><span class="legend-lecture">Лекции</span><span class="legend-practice">Практики</span><span class="legend-lab">Лабораторные</span></div></div>
    <section class="timetable" aria-label="Расписание занятий"><div class="weeknav">
      <button id="prev" aria-label="Предыдущая неделя" ${at <= 0 ? 'disabled' : ''}>${ICONS.left}<span>Назад</span></button>
      <div class="title">${dayMonth(view.week)} – ${dayMonth(weekEnd)}<small>${
        view.week === mondayOf(now.date) ? 'текущая неделя' : view.week === addDays(mondayOf(now.date), 7) ? 'следующая неделя' : data.label && data.form === 'part' ? esc(data.label) : ' '
      }</small></div>
      <button id="today" class="today-btn" title="Вернуться к сегодняшнему дню">Сегодня</button>
      <button id="next" aria-label="Следующая неделя" ${at >= weeks.length - 1 ? 'disabled' : ''}><span>Вперёд</span>${ICONS.right}</button>
    </div>
    <div class="daystrip" role="tablist">${days
      .map(
        ({ date, list }) =>
          `<button role="tab" data-day="${date}" aria-selected="${date === view.day}" class="${list.length ? 'has' : ''} ${date === now.date ? 'today' : ''}"><span>${DAYS[weekday(date)]}</span><b>${Number(date.slice(8))}</b><i></i></button>`,
      )
      .join('')}</div>
    ${!days.find(day => day.date === view.day)?.list.length ? `<div class="empty-day"><span>${view.day < first || view.day > last ? 'На этот день расписание ещё не опубликовано' : view.day === now.date ? 'Сегодня занятий нет' : 'В этот день занятий нет'}</span>${lessons.some(l => l.d > view.day) ? '<button id="upcoming">К ближайшему учебному дню →</button>' : ''}</div>` : ''}
    <div class="grid" style="--days:${days.length}">${grid}</div></section>`

  app.querySelectorAll('.changes').forEach(animateDetails)
  const redraw = (motion = false) => {
    const focused = document.activeElement
    const id = focused?.id
    const day = focused?.dataset?.day
    renderSchedule(kind, data, view)
    if (motion) {
      animateContent(app.querySelector('.grid'))
      const replacement = day ? app.querySelector(`[data-day="${day}"]`) : id ? document.getElementById(id) : null
      if (replacement) replacement.focus({ preventScroll: true })
    }
  }
  app.querySelector('#today').onclick = () => {
    view.week = mondayOf(minskNow().date)
    view.day = minskNow().date
    redraw(true)
  }
  const nextDay = app.querySelector('#upcoming')
  if (nextDay) nextDay.onclick = () => {
    const target = lessons.find(l => l.d > view.day)
    if (target) { view.week = mondayOf(target.d); view.day = target.d; redraw(true) }
  }
  app.querySelector('#prev').onclick = () => {
    view.week = weeks[at - 1]
    view.day = null
    redraw(true)
  }
  app.querySelector('#next').onclick = () => {
    view.week = weeks[at + 1]
    view.day = null
    redraw(true)
  }
  app.querySelectorAll('[data-day]').forEach(button => {
    button.onclick = () => {
      view.day = button.dataset.day
      redraw(true)
    }
  })
  const mineButton = app.querySelector('#mine')
  if (mineButton)
    mineButton.onclick = () => {
      store.set('my', isMine ? null : { kind, id: data.id })
      redraw(true)
    }
  clearInterval(timer)
  const renderedDate = now.date
  timer = setInterval(() => {
    const current = minskNow()
    if (current.date !== renderedDate) {
      view.week = null; view.day = null
      const top = window.scrollY
      redraw()
      window.scrollTo(0, top)
      return
    }
    const slot = document.getElementById('now')
    if (slot) slot.innerHTML = nowCard(kind, lessons)
    app.querySelectorAll('.lesson[data-date]').forEach(card => {
      const { date, start, end } = card.dataset
      const past = date < current.date || (date === current.date && minutes(end) <= current.minutes)
      card.classList.toggle('past', past)
      card.classList.toggle('live', date === current.date && minutes(start) <= current.minutes && !past)
    })
  }, 30000)
}

// ---------- routing ----------

async function route(keepScroll = false) {
  const scrollTop = keepScroll === true ? window.scrollY : 0
  const version = ++routeVersion
  clearInterval(timer)
  hideResults()
  input.value = ''
  const [, kind, rawId] = location.hash.replace(/^#/, '').split('/')
  try {
    const id = rawId ? decodeURIComponent(rawId) : ''
    document.querySelectorAll('[data-nav]').forEach(item => {
      const saved = store.get('my')
      const selected = kind === 'all' ? (id === 't' ? 'teachers' : id === 'r' ? 'rooms' : 'groups')
        : saved?.kind === kind && saved?.id === id ? 'mine' : kind === 't' ? 'teachers' : kind === 'r' ? 'rooms' : 'groups'
      const on = item.dataset.nav === selected
      item.classList.toggle('active', on)
      if (on) item.setAttribute('aria-current', 'page')
      else item.removeAttribute('aria-current')
    })
    if (!index || refreshIndex) {
      const fresh = await getJson('data/index.json')
      if (version !== routeVersion) return
      index = fresh
      refreshIndex = false
    }
    foot.innerHTML = `<span>Неофициальный сайт. Данные: <a href="https://rasp.bru.by/" rel="noopener">rasp.bru.by</a>, версия от ${esc(index.generated)}.</span>
      <span>Проверено ${new Date(index.checked || index.synced).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</span>`
    if (kind === 'g' || kind === 't' || kind === 'r') {
      app.innerHTML = '<p class="loading">Загрузка…</p>'
      const data = await getJson(`data/${kind}/${encodeURIComponent(id)}.json`)
      if (version !== routeVersion) return
      renderSchedule(kind, data, views.get(`${kind}/${data.id}`) || {})
      animateContent()
      window.scrollTo(0, scrollTop)
      return
    }
    const mine = store.get('my')
    if (!kind && mine) {
      location.replace(`#/${mine.kind}/${encodeURIComponent(mine.id)}`)
      return
    }
    renderHome(['full', 'part', 't', 'r'].includes(id) ? id : 'full')
    animateContent()
  } catch (error) {
    if (version !== routeVersion) return
    const gone = /: 404$/.test(error.message) && kind
    app.innerHTML = `<div class="error"><b>${gone ? 'Такого расписания сейчас нет' : 'Не удалось загрузить расписание'}</b>${
      gone ? 'Возможно, у группы нет занятий в ближайшие две недели.' : 'Проверьте соединение и обновите страницу.'
    } <a href="#/all">К списку групп</a></div>`
  }
}

window.addEventListener('hashchange', route)
window.addEventListener('online', () => { refreshIndex = true; route(true) })
window.addEventListener('offline', () => { offline = true; route(true) })
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refreshIndex = true; route(true) }
})
setInterval(() => { if (!document.hidden && navigator.onLine) { refreshIndex = true; route(true) } }, 5 * 60000)
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {})
route()
