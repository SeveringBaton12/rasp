#!/usr/bin/env python3
"""Pulls the timetable from rasp.bru.by and writes it as JSON under docs/data.

The source is a set of generated HTML pages. They are read politely (a few
requests at a time), parsed into lessons, checked for sanity and only then
written, so a broken source page never replaces good data.
"""
import datetime as dt
import html
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://rasp.bru.by/'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'data')
WORKERS = 6
AGENT = 'rasp-mirror/1.0 (unofficial timetable viewer; reads each page at most hourly)'
# A sync that finds fewer than this share of the groups it had last time is
# taken for a broken source and leaves the old data in place.
MIN_SHARE = 0.7

TYPES = {
    'lecture': 'Лекция', 'practice': 'Практика', 'lab': 'Лабораторная', 'pe': 'Физкультура',
    'in_class_control': 'Ауд. контроль', 'curator_hour': 'Инф. час', 'exam': 'Экзамен',
    'credit': 'Зачёт', 'diff_credit': 'Диф. зачёт', 'consultation': 'Консультация',
    'coursework': 'Курсовая',
}

opener = urllib.request.build_opener()


def fetch(path, tries=3):
    url = BASE + urllib.parse.quote(path)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': AGENT})
            with opener.open(req, timeout=40) as res:
                return res.read().decode('utf-8', 'replace')
        except Exception as error:  # noqa: BLE001 - retried, then reported
            if attempt == tries - 1:
                raise RuntimeError(f'{path}: {error}') from error
            time.sleep(2 * (attempt + 1))


def text(fragment):
    """The visible text of an HTML fragment, whitespace collapsed."""
    fragment = re.sub(r'<br\s*/?>', '\n', fragment)
    fragment = html.unescape(re.sub(r'<[^>]+>', '', fragment))
    lines = [re.sub(r'\s+', ' ', line).strip() for line in fragment.split('\n')]
    return '\n'.join(line for line in lines if line)


def slug(name):
    return re.sub(r'[^\w.-]+', '_', name, flags=re.U).strip('_')


def blocks(page, cls):
    """Inner HTML of every <div> whose class list starts with `cls`."""
    out = []
    for match in re.finditer(r'<div class="%s[^"]*"[^>]*>' % re.escape(cls), page):
        depth, pos = 1, match.end()
        for tag in re.finditer(r'<(/?)div\b[^>]*>', page[pos:]):
            depth += -1 if tag.group(1) else 1
            if depth == 0:
                out.append((match.group(0), page[pos:pos + tag.start()]))
                break
    return out


def period_of(page):
    found = re.search(r'(\d{2})\.(\d{2})\.(\d{4})\s*[—–-]\s*(\d{2})\.(\d{2})\.(\d{4})', page)
    if not found:
        return None
    d1, m1, y1, d2, m2, y2 = map(int, found.groups())
    return dt.date(y1, m1, d1), dt.date(y2, m2, d2)


def date_in(period, day, month):
    """The full date of `day.month`, the year taken from the page's period."""
    start, end = period
    for year in {start.year, end.year, start.year - 1, end.year + 1}:
        try:
            date = dt.date(year, month, day)
        except ValueError:
            continue
        if start - dt.timedelta(days=10) <= date <= end + dt.timedelta(days=10):
            return date
    return dt.date(start.year, month, day)


def tables(page, period):
    """Yields (date, pair number, start, end, cell html) for every table cell."""
    for table in re.findall(r'<table class="schedule-table">(.*?)</table>', page, re.S):
        head = re.search(r'<thead>(.*?)</thead>', table, re.S).group(1)
        dates = []
        for th in re.findall(r'<th\b[^>]*>(.*?)</th>', head, re.S)[1:]:
            found = re.search(r'(\d{2})\.(\d{2})', th)
            dates.append(date_in(period, int(found.group(1)), int(found.group(2))) if found else None)
        body = re.search(r'<tbody>(.*?)</tbody>', table, re.S).group(1)
        for row in re.findall(r'<tr\b[^>]*>(.*?)</tr>', body, re.S):
            cells = re.findall(r'<td\b[^>]*>(.*?)</td>', row, re.S)
            if not cells:
                continue
            slot = text(cells[0])
            number = re.search(r'(\d+)\s*пара', slot)
            times = re.search(r'(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})', slot)
            if not times:
                continue
            for date, cell in zip(dates, cells[1:]):
                if date is not None:
                    yield date, int(number.group(1)) if number else 0, times.group(1), times.group(2), cell


def parse_group(page):
    period = period_of(page)
    if period is None:
        raise ValueError('no period on the page')
    lessons = []
    for date, number, start, end, cell in tables(page, period):
        for opening, inner in blocks(cell, 'lesson-card'):
            kind = re.search(r'lesson-card lesson-([a-z_]+)', opening)
            title = blocks(inner, 'title')
            info = blocks(inner, 'info')
            if not title:
                continue
            sub = re.search(r'<small>\s*\[(.*?)\]\s*</small>', title[0][1], re.S)
            subject = text(re.sub(r'<small>.*?</small>', '', title[0][1], flags=re.S)).replace('\n', ' ')
            teacher = room = label = ''
            for line in (text(info[0][1]).split('\n') if info else []):
                if line.startswith('👤'):
                    teacher = line[1:].strip()
                elif line.startswith('📍'):
                    room = line[1:].strip()
                else:
                    label = line
            kind = kind.group(1) if kind else ''
            lessons.append({
                'd': date.isoformat(), 'n': number, 's': start, 'e': end, 'subj': subject,
                'type': kind, 'label': TYPES.get(kind) or label, 'teacher': teacher, 'room': room,
                'sub': sub.group(1).strip() if sub else '',
            })
    return period, lessons


def parse_teacher(page):
    period = period_of(page)
    if period is None:
        raise ValueError('no period on the page')
    lessons = []
    for date, number, start, end, cell in tables(page, period):
        for opening, inner in blocks(cell, 'occ-card'):
            kind = re.search(r'occ-card occ-([a-z_]+)', opening)
            lines = {n: text(b[1]).replace('\n', ' ') for n in range(1, 6) for b in blocks(inner, 'occ-line%d' % n)[:1]}
            groups = lines.get(3, '')
            sub = re.search(r'\((.*?)\)\s*$', groups)
            kind = kind.group(1) if kind else ''
            lessons.append({
                'd': date.isoformat(), 'n': number, 's': start, 'e': end,
                'subj': re.sub(r'\s*📚\s*$', '', lines.get(2, '')).strip(),
                'type': kind, 'label': TYPES.get(kind) or lines.get(1, ''),
                'groups': re.sub(r'\s*\(.*?\)\s*$', '', groups).strip(),
                'sub': sub.group(1).strip() if sub else '',
                'room': re.sub(r'^\W+', '', lines.get(4, ''), flags=re.U).strip(),
            })
    return period, lessons


def crawl_groups():
    """Every group of both forms: (form, faculty, course, name, page path, period label)."""
    found = []
    for form, folder in (('full', 'full_time'), ('part', 'part_time')):
        index = fetch(folder + '/index.html')
        for faculty_href in re.findall(r'<a href="([^"/][^"]*/index\.html)"', index):
            faculty = html.unescape(faculty_href.rsplit('/', 1)[0])
            page = fetch(f'{folder}/{faculty}/index.html')
            course = ''
            for item in re.finditer(
                r'<div class="course-header">(.*?)</div>|<a href="([^"]+)" class="group-link">(.*?)</a>', page, re.S
            ):
                if item.group(1) is not None:
                    course = text(item.group(1))
                    continue
                name = re.search(r'<strong>(.*?)</strong>', item.group(3), re.S)
                label = re.search(r'class="period-label">(.*?)</span>', item.group(3), re.S)
                found.append({
                    'form': form, 'faculty': faculty, 'course': course,
                    'name': text(name.group(1)) if name else '',
                    'path': f'{folder}/{faculty}/{html.unescape(item.group(2))}',
                    'period': text(label.group(1)) if label else '',
                })
    return found


def crawl_teachers():
    page = fetch('index1.html')
    found = []
    for item in re.finditer(
        r'data-name="([^"]*)">\s*<a href="([^"]+)"(.*?)</a>', page, re.S
    ):
        position = re.search(r'class="teacher-position">(.*?)</div>', item.group(3), re.S)
        found.append({
            'name': html.unescape(item.group(1)).strip(),
            'position': text(position.group(1)) if position else '',
            'path': html.unescape(item.group(2)),
        })
    return found


def short_name(full):
    """«Агеева Тамара Николаевна» as the group pages spell it: «Агеева Т.Н»."""
    parts = full.split()
    if len(parts) < 2:
        return full
    return parts[0] + ' ' + '.'.join(part[0] for part in parts[1:])


def room_key(room):
    return slug(room.replace('корпус', 'к').replace('ауд.', '').replace(',', ' '))


def main():
    started = time.time()
    home = fetch('index.html')
    generated = re.search(r'Сгенерировано:\s*([\d.]+ [\d:]+)', home)
    generated = generated.group(1) if generated else ''

    index_path = os.path.join(ROOT, 'index.json')
    previous = None
    if os.path.exists(index_path):
        with open(index_path, encoding='utf-8') as file:
            previous = json.load(file)
    complete = previous and all(
        os.path.isfile(os.path.join(ROOT, folder, item['id'] + '.json'))
        for folder, key in (('g', 'groups'), ('t', 'teachers'), ('r', 'rooms'))
        for item in previous.get(key, [])
    )
    if previous and complete and generated and previous.get('generated') == generated and '--force' not in sys.argv:
        previous['checked'] = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
        with open(index_path, 'w', encoding='utf-8') as file:
            json.dump(previous, file, ensure_ascii=False, separators=(',', ':'))
        print(f'source unchanged since {generated}: verification refreshed')
        return 0

    groups = crawl_groups()
    teachers = crawl_teachers()
    print(f'found {len(groups)} groups, {len(teachers)} teachers')

    failures = []

    def load(item, parser):
        try:
            item['period_dates'], item['lessons'] = parser(fetch(item['path']))
        except Exception as error:  # noqa: BLE001 - one bad page must not stop the sync
            failures.append(f'{item["path"]}: {error}')
            item['lessons'] = None
        return item

    with ThreadPoolExecutor(WORKERS) as pool:
        groups = list(pool.map(lambda g: load(g, parse_group), groups))
        teachers = list(pool.map(lambda t: load(t, parse_teacher), teachers))

    groups = [g for g in groups if g['lessons'] is not None and g['name']]
    teachers = [t for t in teachers if t['lessons'] is not None and t['name']]

    # Sanity: a source whose template changed parses into nothing
    problems = []
    if not groups or not teachers:
        problems.append('no groups or no teachers parsed')
    if sum(len(g['lessons']) for g in groups) < 500:
        problems.append('fewer than 500 lessons in total')
    if previous and len(groups) < MIN_SHARE * len(previous.get('groups', [])):
        problems.append(f'{len(groups)} groups, {len(previous["groups"])} last time')
    if failures:
        problems.append(f'{len(failures)} pages failed')
    if problems:
        print('SYNC REFUSED, old data kept:', '; '.join(problems), file=sys.stderr)
        for line in failures[:20]:
            print('  ', line, file=sys.stderr)
        return 1

    # Ids
    seen = set()
    for item in groups + teachers:
        base = slug(item['name'])
        ident, n = base, 2
        while ident in seen:
            ident, n = f'{base}_{n}', n + 1
        seen.add(ident)
        item['id'] = ident

    # Link a group lesson to its teacher's page when the short name is unique
    by_short = {}
    for teacher in teachers:
        by_short.setdefault(short_name(teacher['name']), []).append(teacher['id'])
    group_ids = {g['name']: g['id'] for g in groups}

    rooms = {}
    for group in groups:
        for lesson in group['lessons']:
            ids = by_short.get(lesson['teacher'].rstrip('.'), [])
            if len(ids) == 1:
                lesson['tid'] = ids[0]
            if lesson['room']:
                key = room_key(lesson['room'])
                lesson['rid'] = key
                room = rooms.setdefault(key, {'id': key, 'name': lesson['room'], 'lessons': {}})
                # One lecture of several groups is one entry in the room
                spot = (lesson['d'], lesson['s'], lesson['subj'], lesson['teacher'])
                entry = room['lessons'].setdefault(spot, {
                    k: lesson[k] for k in ('d', 'n', 's', 'e', 'subj', 'type', 'label', 'teacher')
                } | {'groups': [], 'tid': lesson.get('tid', '')})
                tag = lesson['sub'] or group['name']
                if tag not in entry['groups']:
                    entry['groups'].append(tag)
    for teacher in teachers:
        for lesson in teacher['lessons']:
            names = [name.strip() for name in lesson['groups'].split(',')]
            lesson['gids'] = [group_ids[name] for name in names if name in group_ids]
            if lesson['room']:
                lesson['rid'] = room_key(lesson['room'])

    out = tempfile.mkdtemp(prefix='rasp-')
    for folder in ('g', 't', 'r'):
        os.makedirs(os.path.join(out, folder))

    def write(path, value):
        with open(os.path.join(out, path), 'w', encoding='utf-8') as file:
            json.dump(value, file, ensure_ascii=False, separators=(',', ':'))

    def iso(period):
        return [period[0].isoformat(), period[1].isoformat()]

    for group in groups:
        subs = sorted({lesson['sub'] for lesson in group['lessons'] if lesson['sub']})
        write(f'g/{group["id"]}.json', {
            'id': group['id'], 'name': group['name'], 'form': group['form'], 'faculty': group['faculty'],
            'course': group['course'], 'period': iso(group['period_dates']), 'label': group['period'],
            'subs': subs, 'lessons': group['lessons'], 'source': BASE + urllib.parse.quote(group['path']),
        })
    for teacher in teachers:
        write(f't/{teacher["id"]}.json', {
            'id': teacher['id'], 'name': teacher['name'], 'position': teacher['position'],
            'period': iso(teacher['period_dates']), 'lessons': teacher['lessons'],
            'source': BASE + urllib.parse.quote(teacher['path']),
        })
    for room in rooms.values():
        lessons = sorted(room['lessons'].values(), key=lambda l: (l['d'], l['s']))
        write(f'r/{room["id"]}.json', {'id': room['id'], 'name': room['name'], 'lessons': lessons})

    write('index.json', {
        'generated': generated,
        'synced': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'checked': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'groups': [
            {k: g[k] for k in ('id', 'name', 'form', 'faculty', 'course')} | {'n': len(g['lessons'])}
            for g in sorted(groups, key=lambda g: g['name'])
        ],
        'teachers': [
            {'id': t['id'], 'name': t['name'], 'position': t['position'], 'n': len(t['lessons'])}
            for t in sorted(teachers, key=lambda t: t['name'])
        ],
        'rooms': sorted(({'id': r['id'], 'name': r['name']} for r in rooms.values()), key=lambda r: r['name']),
        'skipped': failures,
    })

    if os.path.isdir(ROOT):
        shutil.rmtree(ROOT)
    shutil.move(out, ROOT)
    os.chmod(ROOT, 0o755)
    lessons = sum(len(g['lessons']) for g in groups)
    print(f'wrote {len(groups)} groups, {len(teachers)} teachers, {len(rooms)} rooms, '
          f'{lessons} lessons in {time.time() - started:.0f}s; skipped {len(failures)}')
    for line in failures:
        print('  skipped', line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
