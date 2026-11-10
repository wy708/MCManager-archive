"""Apply Windows-spawn compatibility and surface-block state capture to MipMap."""
import argparse
import base64
import csv
import hashlib
import io
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from update_blacklist import restore_transparent_blocks

OFFICIAL_SHA256 = "6366d44e61e59ab9b7a8bd84b7e770b445af4d16d64433f1bf6aae7ad17db373"
VERSION = "1.0.3+mcmanager.6"


def prepare(source, output):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != OFFICIAL_SHA256:
        raise ValueError("Input is not the pinned official MipMap 1.0.3 release wheel")
    with ZipFile(io.BytesIO(raw)) as archive:
        files = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    files['endstone_mipmap/config.toml'] = restore_transparent_blocks(files['endstone_mipmap/config.toml'].decode()).encode()
    main = files["endstone_mipmap/main.py"].decode("utf-8")
    # Join/quit used to call _sendPlayers, which recursively scheduled another
    # perpetual timer. Keep one periodic chain; event handlers only publish state.
    timer = '        self.server.scheduler.run_task(self, self._sendPlayers, delay=100)'
    assert main.count(timer) == 1
    main = main.replace(timer, '        self.server.scheduler.run_task(self, self._periodicPlayers, delay=100)')
    marker = '    def _sendPlayers(self) -> None:'
    assert main.count(marker) == 1
    main = main.replace(marker, '    def _periodicPlayers(self) -> None:\n        try:\n            self._sendPlayers()\n        finally:\n            self._schedulePlayersUpdate()\n\n' + marker)
    start = main.index(marker)
    tail = main[start:]
    assert tail.count('        self._schedulePlayersUpdate()') == 1
    main = main[:start] + tail.replace('        self._schedulePlayersUpdate()', '')
    main = main.replace('self._playersQueue = mp.Queue()', 'self._playersQueue = mp.Queue(maxsize=2)')
    enqueue = '        self._playersQueue.put(playerData)'
    assert main.count(enqueue) == 1
    main = main.replace(enqueue, '''        try:
            self._playersQueue.put_nowait(playerData)
        except queue.Full:
            try:
                self._playersQueue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._playersQueue.put_nowait(playerData)
            except queue.Full:
                pass''')
    main = 'import queue\n' + main
    files['endstone_mipmap/core/playersSender.py'] = Path(__file__).with_name('players_sender.py').read_bytes()
    # Bound chunk concurrency while preserving each payload and its original receipt.
    chunk_sender = files['endstone_mipmap/core/chunksSender.py'].decode().replace('\r', '')
    assert chunk_sender.count('asyncio.create_task(self._sendChunkData(session, chunkData))') == 1
    start = chunk_sender.index('    async def run(')
    chunk_sender = chunk_sender[:start] + '''    async def run(self, queue: mp.Queue) -> None:
        async with aiohttp.ClientSession() as session:
            async def worker():
                while True:
                    try:
                        chunkData = queue.get_nowait()
                    except Empty:
                        await asyncio.sleep(0.1)
                        continue
                    await self._sendChunkData(session, chunkData)
            await asyncio.gather(*(worker() for _ in range(4)))
'''
    chunk_sender = 'from queue import Empty\n' + chunk_sender
    files['endstone_mipmap/core/chunksSender.py'] = chunk_sender.encode()
    needle = '"coordinates": [block.x, block.y, block.z]'
    assert main.count(needle) == 1, 'Pinned surface capture changed'
    main = main.replace(needle, needle + ',\n                    "states": dict(block.data.block_states)')
    main = main.replace('        self.register_events(self)', '        from .nether_capture import NetherCapture\n        from .surface_refresh import SurfaceRefresh\n        self._netherCapture = NetherCapture(self)\n        self._surfaceRefresh = SurfaceRefresh(self)\n        self.register_events(self)')
    start = main.index('    def loadChunk(self, event: ChunkLoadEvent):')
    end = main.index('    @event_handler', start)
    main = main[:start] + '    def loadChunk(self, event: ChunkLoadEvent):\n        self._surfaceRefresh.enqueue(event.chunk, force=True)\n\n' + main[end:]
    main = main.replace('    def on_disable(self)', '''        self._surfaceRefresh.start()
        self._netherCapture.start()

    def on_disable(self)''')
    main = main.replace('    def on_disable(self) -> None:', '    def on_disable(self) -> None:\n        self._netherCapture.report()\n        self._surfaceRefresh.report()')
    files['endstone_mipmap/surface_refresh.py'] = Path(__file__).with_name('surface_refresh.py').read_bytes()
    files['endstone_mipmap/nether_capture.py'] = Path(__file__).with_name('nether_capture.py').read_bytes()
    for filename in ('surface_layers.py', 'transparent_blocks.json'):
        files['endstone_mipmap/'+filename] = Path(__file__).with_name(filename).read_bytes()
    start = main.index("def startChunkSender(")
    end = main.index("class Map(Plugin):")
    workers = main[start:end]
    files["endstone_mipmap/workers.py"] = (
        "# MCManager compatibility: transport-only workers must not import the game runtime.\n"
        "import asyncio\nimport multiprocessing as mp\n"
        "from .core.chunksSender import ChunksSender\n"
        "from .core.playersSender import PlayersSender\n\n" + workers
    ).encode("utf-8")
    files["endstone_mipmap/main.py"] = (main[:start] + "from .workers import startChunkSender, startPlayersSender\n\n\n" + main[end:]).encode("utf-8")
    files["endstone_mipmap/__init__.py"] = b'''# Preserve the original entry point while allowing transport-only child imports.
__all__ = ["Map"]

def __getattr__(name):
    if name == "Map":
        from .main import Map
        return Map
    raise AttributeError(name)
'''
    files["endstone_mipmap/core/__init__.py"] = b'''from .chunksSender import ChunksSender
from .playersSender import PlayersSender
__all__ = ["BatchTracker", "ChunksSender", "PlayersSender"]

def __getattr__(name):
    if name == "BatchTracker":
        from .tracker import BatchTracker
        return BatchTracker
    raise AttributeError(name)
'''
    old = "endstone_mipmap-1.0.3.dist-info/"
    new = f"endstone_mipmap-{VERSION}.dist-info/"
    files = {name.replace(old, new): content for name, content in files.items() if not name.endswith("/RECORD")}
    metadata = new + "METADATA"
    files[metadata] = files[metadata].replace(b"Version: 1.0.3\n", f"Version: {VERSION}\n".encode()).replace(b"Version: 1.0.3\r\n", f"Version: {VERSION}\r\n".encode())
    record = io.StringIO(newline="")
    writer = csv.writer(record, lineterminator="\n")
    for name, content in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        writer.writerow([name, "sha256=" + digest, len(content)])
    writer.writerow([new + "RECORD", "", ""])
    files[new + "RECORD"] = record.getvalue().encode()
    output.mkdir(parents=True, exist_ok=True)
    wheel = output / f"endstone_mipmap-{VERSION}-py2.py3-none-any.whl"
    with ZipFile(wheel, "w", compression=ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    print(wheel)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wheel", type=Path)
    parser.add_argument("--output", type=Path, default=Path("map/dist"))
    args = parser.parse_args()
    prepare(args.wheel, args.output)
