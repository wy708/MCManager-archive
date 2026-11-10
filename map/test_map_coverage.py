import tempfile
import unittest
from pathlib import Path
from map_coverage import scan_coverage


class CoverageTests(unittest.TestCase):
    def test_offset_terrain_and_unmapped_dimensions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'Overworld/tiles/zoom-4'
            folder.mkdir(parents=True)
            for name in ['(-40)-(-2).png', '(-39)-(1).png', 'ignored.tmp']:
                (folder / name).touch()
            data = scan_coverage(root)
            self.assertEqual(set(data), {'Overworld'})
            self.assertEqual(data['Overworld']['bounds'], [[-32, -640], [32, -608]])
            self.assertIn(data['Overworld']['focus'], [[24, -632], [-24, -616]])
            self.assertEqual(data['Overworld']['tileCount'], 2)

    def test_disconnected_regions_focus_an_existing_tile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / 'Nether_64/tiles/zoom-4'
            folder.mkdir(parents=True)
            for name in ['(-100)-(0).png', '(100)-(0).png']:
                (folder / name).touch()
            data = scan_coverage(root)['Nether_64']
            self.assertIn(data['focus'], [[-8, -1592], [-8, 1608]])


if __name__ == '__main__':
    unittest.main()
