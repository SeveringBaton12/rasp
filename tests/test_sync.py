"""Regression checks for preserving the last good publication."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sync', Path(__file__).parents[1] / 'scripts/sync.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def test_partial_failure_preserves_previous_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'data'
            root.mkdir()
            original = json.dumps({'generated': 'old', 'groups': [{'id': f'G{i}'} for i in range(10)]})
            (root / 'index.json').write_text(original)
            (root / 'keep.json').write_text('last good timetable')
            groups = [dict(name=f'G{i}', path=str(i)) for i in range(10)]
            def parse(page):
                if page == '0':
                    raise ValueError('temporary source failure')
                return (dt.date(2026, 11, 1), dt.date(2026, 11, 30)), [{}] * 60
            with patch.multiple(sync, ROOT=str(root), fetch=lambda p: p,
                                crawl_groups=lambda: groups,
                                crawl_teachers=lambda: [dict(name='T', path='teacher')],
                                parse_group=parse, parse_teacher=parse):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(sync.main(), 1)
            self.assertEqual((root / 'index.json').read_text(), original)
            self.assertEqual((root / 'keep.json').read_text(), 'last good timetable')

    def test_unchanged_source_refreshes_check_without_recrawling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'g').mkdir()
            (root / 'g/G.json').write_text('{}')
            (root / 'index.json').write_text(json.dumps({
                'generated': '13.11.2026 00:11', 'synced': 'old', 'groups': [{'id': 'G'}],
                'teachers': [], 'rooms': [],
            }))
            with patch.multiple(sync, ROOT=str(root), fetch=lambda p: 'Сгенерировано: 13.11.2026 00:11'), patch.object(sync, 'crawl_groups') as crawl, patch('sys.argv', ['sync.py']):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(sync.main(), 0)
                crawl.assert_not_called()
            data = json.loads((root / 'index.json').read_text())
            self.assertTrue(data['checked'])
            self.assertEqual(data['synced'], 'old')

    def test_missing_cached_files_force_recrawl(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'index.json').write_text(json.dumps({
                'generated': '13.11.2026 00:11', 'groups': [{'id': 'missing'}],
            }))
            with patch.multiple(sync, ROOT=str(root), fetch=lambda p: 'Сгенерировано: 13.11.2026 00:11', crawl_groups=lambda: [], crawl_teachers=lambda: []), patch('sys.argv', ['sync.py']):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(sync.main(), 1)


if __name__ == '__main__':
    unittest.main()
