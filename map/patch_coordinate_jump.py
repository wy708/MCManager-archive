"""Add coordinate navigation without altering game state or the tile protocol."""
import sys
from pathlib import Path

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/app')
assets = Path(__file__).parent
viewer = root / 'web/static/js/map.js'
text = viewer.read_text(encoding='utf-8')
if 'function mcmanagerMapLanguage()' not in text:
    text = (assets / 'viewer_language.js').read_text(encoding='utf-8') + '\n' + text
    viewer.write_text(text, encoding='utf-8')
if 'initCoordinateJump() {' not in text:
    assert '    this.initEventListeners();' in text
    assert '  initEventListeners() {' in text
    assert '  focusMappedArea() {' in text
    text = text.replace('    this.initEventListeners();', '    this.initEventListeners();\n    this.initCoordinateJump();')
    text = text.replace('  initEventListeners() {', (assets / 'coordinate_jump.js').read_text(encoding='utf-8') + '\n  initEventListeners() {')
    # A marker belongs to the selected dimension/layer; don't carry it across.
    text = text.replace('  focusMappedArea() {', '  focusMappedArea() {\n    this.coordinateTarget?.remove();\n    this.coordinateTarget = null;')
    viewer.write_text(text, encoding='utf-8')
css = root / 'web/static/css/style.css'
text = css.read_text(encoding='utf-8')
if '/* MCManager coordinate jump */' not in text:
    css.write_text(text + '\n' + (assets / 'coordinate_jump.css').read_text(encoding='utf-8'), encoding='utf-8')
