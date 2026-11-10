"""Focus the original viewer on mapped terrain on both small and large screens."""
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/app')
config = root / 'api/config.py'
text = config.read_text(encoding='utf-8')
if 'get_map_coverage' not in text:
    assert 'async def getConfig()' in text
    text = 'from services.map_coverage import get_map_coverage\nfrom starlette.concurrency import run_in_threadpool\n' + text
    needle = '"mapSize": MAP_SIZE,'
    assert needle in text
    text = text.replace(needle, needle + '\n        "coverage": await run_in_threadpool(get_map_coverage),')
    config.write_text(text, encoding='utf-8')

viewer = root / 'web/static/js/map.js'
text = viewer.read_text(encoding='utf-8')
if 'focusMappedArea() {' not in text:
    needle = '      this.currentWorld = this.config.defaultWorld;'
    assert needle in text
    text = text.replace(needle, needle + '\n      this.config.coverage = serverConfig.coverage || {};')
    needle = '    this.map.setView([0, 0], 2);\n    this.map.fitBounds(bounds);'
    assert needle in text
    text = text.replace(needle, '    this.focusMappedArea();')
    method = '''  focusMappedArea() {
    const size = this.config.mapSize;
    const extent = L.latLngBounds([[-size, -size], [size, size]]);
    const dimension = this.currentWorld === "Nether" ? "Nether_" + this.netherHeight : this.currentWorld;
    const coverage = this.config.coverage?.[dimension];
    if (!coverage || !Array.isArray(coverage.bounds) || !Array.isArray(coverage.focus)) {
      this.map.setMaxBounds(extent);
      this.map.fitBounds(extent, { animate: false });
      return;
    }
    const mapped = L.latLngBounds(coverage.bounds);
    if (!mapped.isValid() || !coverage.focus.every(Number.isFinite)) return;
    this.map.setMaxBounds(extent.extend(mapped).pad(0.1));
    const zoom = Math.max(this.config.minZoom, Math.min(2,
      this.map.getBoundsZoom(mapped, false, L.point(48, 180))));
    this.map.setView(coverage.focus, zoom, { animate: false });
  }

'''
    text = text.replace('  initTileLayer() {', method + '  initTileLayer() {')
    # Both dimension switching and the existing Nether layer selector.
    text = re.sub(r'(this\.map\.removeLayer\(this\.currentTileLayer\);\n)(\s*)(this\.initTileLayer\(\);)',
                  r'\1\2this.focusMappedArea();\n\2\3', text)
    viewer.write_text(text, encoding='utf-8')
