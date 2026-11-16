"""Run inside the patched MipMap image (PYTHONPATH=/app)."""
import asyncio
import os
from pathlib import Path
import queue
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image
from models.chunk import ChunkData, ChunkRequest
from services.tileService import TileQueueManager
from services.map_compat import atomic_image, save_tiles
from services.zoomGenerator import ZoomGenerator
from api.chunks import receiveChunkData


class MemoryTests(unittest.TestCase):
    def chunk(self):
        return ChunkData(dimension='Overworld', blocks=[
            {'name': 'minecraft:stone', 'coordinates': [-1, 64, -1],
             'states': {}, 'layers': []}])

    def test_queue_bounded_serialized_roundtrip(self):
        manager = TileQueueManager()
        try:
            for _ in range(256):
                manager.addTask(self.chunk())
            with self.assertRaises(queue.Full):
                manager.addTask(self.chunk())
            for _ in range(256):
                payload = manager.tileQueue.get(timeout=2)
                self.assertIsInstance(payload, bytes)
                self.assertEqual(ChunkData.model_validate_json(payload), self.chunk())
        finally:
            manager.tileQueue.close()
            manager.tileQueue.join_thread()

    def test_oversized_payload_not_accepted(self):
        manager = TileQueueManager()
        oversized = type('Oversized', (), {'model_dump_json': lambda self: 'x' * (2 * 1024 * 1024 + 1)})()
        try:
            with self.assertRaises(ValueError):
                manager.addTask(oversized)
            self.assertEqual(manager.tileQueue.qsize(), 0)
        finally:
            manager.tileQueue.close()

    def test_busy_is_retryable_not_success(self):
        with patch('api.chunks.tileManager.addTask', side_effect=queue.Full):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(receiveChunkData(ChunkRequest(chunk=self.chunk())))
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.headers['Retry-After'], '2')

    def test_unchanged_zoom_not_rewritten_and_changed_child_repaired(self):
        previous = os.getcwd()
        with tempfile.TemporaryDirectory() as temporary:
            try:
                os.chdir(temporary)
                leaf = Path('data/worlds/Overworld/tiles/zoom-4')
                leaf.mkdir(parents=True)
                with Image.new('RGBA', (256, 256), (255, 0, 0, 255)) as image:
                    save_tiles({(-1, -1): image}, leaf)
                base = leaf.parent
                before = {p: p.stat().st_mtime_ns for p in base.rglob('*.png')}
                generator = ZoomGenerator()
                for z in range(3, -1, -1):
                    generator._generateZoomLevel(z, base)
                self.assertEqual(before, {p: p.stat().st_mtime_ns for p in before})
                target = base / 'zoom-3/(-1)-(-1).png'
                source = leaf / '(-1)-(-1).png'
                with Image.new('RGBA', (256, 256), (0, 0, 255, 255)) as image:
                    atomic_image(image, source)
                old_time = before[target] - 2_000_000_000
                os.utime(target, ns=(old_time, old_time))
                generator._generateZoomLevel(3, base)
                with Image.open(target) as image:
                    self.assertEqual(image.getpixel((200, 200)), (0, 0, 255, 255))
            finally:
                os.chdir(previous)


if __name__ == '__main__':
    unittest.main()
