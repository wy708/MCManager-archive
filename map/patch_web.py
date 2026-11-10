"""Targeted upstream fixes: Bedrock texture names and coherent zoom tiles."""
from pathlib import Path

root = Path('/app')
renderer = root / 'services/tileGenerator.py'
text = renderer.read_text()
text = text.replace('from core.config import WORLDS_DIR', 'from core.config import WORLDS_DIR\nfrom services.map_compat import save_tiles\nfrom services.block_materials import texture_for')
needle = '        textureName = f"{block.name.removeprefix(\'minecraft:\')}.png"'
assert needle in text
text = text.replace(needle, '''        resolved = texture_for(block)
        if resolved is not None:
            return resolved
        # Preserve the original missing-texture diagnostic for custom/unknown blocks.
        textureName = f"{block.name.replace(':', '__')}.png"''')
needle = '''        for tileKey, tileImage in tileMap.items():
            tileX, tileY = tileKey
            tilePath = tilesPath / f"({tileX})-({tileY}).png"
            tileImage.save(tilePath)'''
assert needle in text
renderer.write_text(text.replace(needle, '        save_tiles(tileMap, tilesPath)'))
text = renderer.read_text()
text = text.replace('    def generateTile(self, chunk: ChunkData) -> None:', '    def generateTile(self, chunk: ChunkData) -> None:\n        self._seaLevel = 0 if chunk.dimension.startswith("Nether") else 63')
renderer.write_text(text)
model = root / 'models/chunk.py'
text = model.read_text().replace('from pydantic import BaseModel', 'from pydantic import BaseModel, Field, StrictBool, StrictInt, StrictStr')
needle = '    coordinates: Tuple[int, int, int]'
assert needle in text
text = text.replace(needle, needle + '\n    states: dict[str, StrictBool | StrictInt | StrictStr] = Field(default_factory=dict)')
text = text.replace('class BlockData(BaseModel):', 'class Cavity(BaseModel):\n    low: int = Field(ge=0, le=126)\n    high: int = Field(ge=0, le=126)\n    name: str\n    coordinates: Tuple[int, int, int]\n    states: dict[str, StrictBool | StrictInt | StrictStr] = Field(default_factory=dict)\n\nclass BlockData(BaseModel):\n    cavities: list[Cavity] | None = Field(default=None, max_length=64)\n')
model.write_text(text)
service = root / 'services/tileService.py'
text = service.read_text().replace('from .tileGenerator import TileRenderer', 'from .tileGenerator import TileRenderer\nfrom .cave_layers import CaveLayers')
text = text.replace('    tile = TileRenderer()', '    tile = TileRenderer()\n    caves = CaveLayers(tile)')
text = text.replace('taskQueue.get(timeout=5)', 'taskQueue.get(timeout=1)')
text = text.replace('            if chunk_data is None:\n                break', '            if chunk_data is None:\n                caves.flush(force=True)\n                break')
text = text.replace('            tile.generateTile(chunk_data)', '            if chunk_data.dimension == "Nether" and any(b.cavities is not None for b in chunk_data.blocks):\n                caves.add(chunk_data)\n            else:\n                tile.generateTile(chunk_data)\n            caves.flush()')
text = text.replace('        except queue.Empty:\n            continue', '        except queue.Empty:\n            caves.flush()\n            continue')
text = text.replace('self.maxWorkers = maxWorkers or min(4, mp.cpu_count())', 'self.maxWorkers = 1  # One owner for the bounded cave graph and persisted input.')
text = text.replace('self.tileQueue = Queue()', 'self.tileQueue = Queue(maxsize=256)')
text = text.replace('self.tileQueue.put(chunk_data)', 'self.tileQueue.put_nowait(chunk_data)')
service.write_text(text)
zooms = root / 'services/zoomGenerator.py'
text = zooms.read_text().replace('from core.config import GENERATE_ZOOM_INTERVAL, WORLDS_DIR', 'from core.config import GENERATE_ZOOM_INTERVAL, WORLDS_DIR\nfrom services.map_compat import locked, atomic_image')
text = text.replace('    def generateZooms(self)', '    @locked\n    def generateZooms(self)')
text = text.replace('targetImage.save(targetTilePath, optimize=True)', 'atomic_image(targetImage, targetTilePath)')
zooms.write_text(text)
viewer = root / 'web/static/js/map.js'
text = viewer.read_text()
needle = '      this.updatePlayerMarkers(data.players);'
assert needle in text
text = text.replace(needle, needle + '\n      this.refreshVisibleTiles();')
refresh = Path('/tmp/live_tiles.js').read_text().replace('async function refreshVisibleTiles()', 'async refreshVisibleTiles()')
text = text.replace('  removeDisconnectedPlayers(activePlayers) {', refresh + '\n  removeDisconnectedPlayers(activePlayers) {')
needle = '    ).addTo(this.map);\n  }\n\n  initEventListeners()'
assert needle in text
text = text.replace(needle, '''    ).addTo(this.map);
    this.currentTileLayer.on('tileunload', ({ tile }) => {
      if (tile.dataset.mapBlob) URL.revokeObjectURL(tile.dataset.mapBlob);
    });
  }

  initEventListeners()''')
text = text.replace('    this.initMap();', '    this.initCaveLayers();\n    this.initMap();')
text = text.replace('  initMap() {', Path('/tmp/layer_controls.js').read_text() + '\n  initMap() {')
text = text.replace('/api/tiles/${this.currentWorld}/', '/api/tiles/${this.currentWorld === "Nether" ? "Nether_" + this.netherHeight : this.currentWorld}/')
text = text.replace('  initTileLayer() {', '  initTileLayer() {\n    if (this.netherLayerControl) this.netherLayerControl.style.display = this.currentWorld === "Nether" ? "block" : "none";')
# A map may be served under the platform origin in a sandboxed document.
# Keep player names as text, and retain coordinate copying when the modern
# clipboard API is unavailable to that isolated document.
text = "const mcmEscapeHtml = value => String(value ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n" + text
text = text.replace('${player.name}', '${mcmEscapeHtml(player.name)}')
needle = 'await navigator.clipboard.writeText(this.elements.coords.textContent);'
assert needle in text
text = text.replace(needle, '''try {
        await navigator.clipboard.writeText(this.elements.coords.textContent);
      } catch (_) {
        const input = document.createElement('textarea');
        input.value = this.elements.coords.textContent;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('Clipboard is unavailable');
      }''')
viewer.write_text(text)
config = root / 'core/config.py'
config.write_text(config.read_text().replace('TILE_CACHE_MAX_AGE = 3600', 'TILE_CACHE_MAX_AGE = 0'))
