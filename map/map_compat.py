"""Linux Docker storage synchronization; upstream rendering algorithms stay intact."""
import fcntl
import functools
import os
import uuid
from pathlib import Path

def locked(function):
    @functools.wraps(function)
    def call(*args, **kwargs):
        with open('data/.mipmap-write.lock', 'a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                return function(*args, **kwargs)
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)
    return call


def atomic_image(image, destination):
    temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        image.save(temporary, format='PNG')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


@locked
def save_tiles(tiles, directory):
    from services.zoomGenerator import ZoomGenerator
    generator = ZoomGenerator()
    base = directory.parent
    for (x, z), image in tiles.items():
        atomic_image(image, directory / f'({x})-({z}).png')
        # Propagate each changed leaf immediately through all four zoom levels.
        for level in range(3, -1, -1):
            x //= 2
            z //= 2
            target = base / f'zoom-{level}'
            target.mkdir(parents=True, exist_ok=True)
            generator._generateTile(x, z, level, base / f'zoom-{level + 1}', target)
