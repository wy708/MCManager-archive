"""Public display bounds derived only from existing map tiles, not game saves."""
import re
import time
from pathlib import Path
from threading import Lock

DIMENSIONS = ('Overworld', 'Nether', 'Nether_32', 'Nether_64', 'Nether_96', 'TheEnd')
TILE_NAME = re.compile(r'^\((-?\d+)\)-\((-?\d+)\)\.png$')
_cache = None
_expires = 0
_lock = Lock()


def scan_coverage(root: Path):
    result = {}
    for dimension in DIMENSIONS:
        folder = root / dimension / 'tiles' / 'zoom-4'
        try:
            tiles = []
            for file in folder.iterdir():
                match = TILE_NAME.fullmatch(file.name)
                if match and file.is_file():
                    tiles.append(tuple(map(int, match.groups())))
        except FileNotFoundError:
            continue
        if not tiles:
            continue
        min_x = min(x for x, _ in tiles)
        max_x = max(x for x, _ in tiles)
        min_y = min(y for _, y in tiles)
        max_y = max(y for _, y in tiles)
        # Choose an actual tile near the centre, so disconnected explored areas
        # do not initially place a small screen over an empty gap.
        cx, cy = (min_x + max_x) / 2, (min_y + max_y) / 2
        fx, fy = min(tiles, key=lambda p: ((p[0] - cx) ** 2 + (p[1] - cy) ** 2, p))
        # Native zoom 4: 256 pixels represent a 16-block-wide tile.
        result[dimension] = {
            'bounds': [[-(max_y + 1) * 16, min_x * 16], [-min_y * 16, (max_x + 1) * 16]],
            'focus': [-(fy + .5) * 16, (fx + .5) * 16],
            'tileCount': len(tiles),
        }
    return result


def get_map_coverage():
    from core.config import WORLDS_DIR
    global _cache, _expires
    with _lock:
        if _cache is None or time.monotonic() >= _expires:
            _cache = scan_coverage(WORLDS_DIR)
            _expires = time.monotonic() + 30
        return _cache
