"""Bound pending chunk memory and avoid locking the renderer for a full zoom scan."""
from pathlib import Path
import sys

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/app')


def replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Pinned MipMap source changed: {old[:80]}')
    return text.replace(old, new)


service = root / 'services/tileService.py'
text = service.read_text()
text = replace(text, 'from .tileGenerator import TileRenderer',
               'from .tileGenerator import TileRenderer\nfrom models.chunk import ChunkData')
# Keep serialized payloads rather than hundreds of expanded Pydantic object graphs.
# The gateway already limits HTTP bodies to 2 MiB; enforce the same bound here.
# Retain the original 256 pending-chunk capacity: old senders do not retry failed
# batches. Serialized queue contents are bounded to 512 MiB (plus IPC overhead),
# instead of retaining potentially much larger expanded Python object graphs.
if 'self.tileQueue = Queue(maxsize=256)' not in text:
    raise RuntimeError('Pinned queue capacity changed')
text = replace(text, '            if chunk_data.dimension == "Nether"',
               '            chunk_data = ChunkData.model_validate_json(chunk_data)\n            if chunk_data.dimension == "Nether"')
text = replace(text, '        self.tileQueue.put_nowait(chunk_data)', '''        payload = chunk_data.model_dump_json().encode('utf-8')
        if len(payload) > 2 * 1024 * 1024:
            raise ValueError('Chunk payload exceeds 2 MiB')
        self.tileQueue.put_nowait(payload)''')
service.write_text(text)

api = root / 'api/chunks.py'
text = 'import queue\n' + api.read_text()
text = replace(text, '    except Exception as e:', '''    except queue.Full:
        raise HTTPException(status_code=503, detail="Map renderer is busy; retry this chunk", headers={"Retry-After": "2"})
    except ValueError as e:
        raise HTTPException(status_code=413, detail=str(e))
    except Exception as e:''')
api.write_text(text)

zooms = root / 'services/zoomGenerator.py'
text = zooms.read_text()
text = replace(text, '    @locked\n    def generateZooms(self):', '    def generateZooms(self):')
text = replace(text, '        sourceTiles = list(sourcePath.glob("*.png"))',
               '        sourceTiles = sourcePath.glob("*.png")')
text = replace(text, '            self._generateTile(targetX, targetY, zoom, sourcePath, targetPath)',
               '            self._refreshTile(targetX, targetY, zoom, sourcePath, targetPath)')
needle = '    def _generateTile(self, x: int, y: int, zoom: int, sourcePath: Path, targetPath: Path):'
text = replace(text, needle, '''    @locked
    def _refreshTile(self, x, y, zoom, sourcePath, targetPath):
        # Lock only one parent tile. Incremental writes already update its ancestors.
        target = targetPath / f"({x})-({y}).png"
        sources = [sourcePath / f"({x * 2 + dx})-({y * 2 + dy}).png"
                   for dx in range(2) for dy in range(2)]
        newest = max((p.stat().st_mtime_ns for p in sources if p.exists()), default=0)
        if target.exists() and target.stat().st_mtime_ns >= newest:
            return
        self._generateTile(x, y, zoom, sourcePath, targetPath)

''' + needle)
text = replace(text, '''                        sourceImage = Image.open(sourceTilePath)
                        resized = sourceImage.resize((self._tileSize // 2, self._tileSize // 2), Image.Resampling.LANCZOS)
                        targetImage.paste(resized, (dx * self._tileSize // 2, dy * self._tileSize // 2))''', '''                        with Image.open(sourceTilePath) as sourceImage:
                            with sourceImage.resize((self._tileSize // 2, self._tileSize // 2), Image.Resampling.LANCZOS) as resized:
                                targetImage.paste(resized, (dx * self._tileSize // 2, dy * self._tileSize // 2))''')
text = replace(text, '            atomic_image(targetImage, targetTilePath)',
               '            atomic_image(targetImage, targetTilePath)\n        targetImage.close()')
zooms.write_text(text)
