"""Restore supported transparent decorations from the upstream workaround blacklist."""
import json
import re
from pathlib import Path

def restore_transparent_blocks(text):
    names=set(json.loads(Path(__file__).with_name('transparent_blocks.json').read_text())['blocks'])
    names.difference_update('minecraft:'+n for n in ('air','cave_air','void_air','structure_void','light_block','barrier','chemical_heat'))
    section=re.search(r'(?ms)^\[blacklist\][ \t]*\r*\n(.*?)(?=^\[|\Z)',text)
    if not section: return text
    match=re.search(r'(?ms)^blocks\s*=\s*\[(.*?)\]',section.group(1))
    if not match: return text
    value=re.sub(r'''["']([^"']+)["']\s*,?''',lambda m:'' if m.group(1).removesuffix('.png') in names else m.group(),match.group(1))
    start=section.start(1)+match.start(1);end=section.start(1)+match.end(1)
    return text[:start]+value+text[end:]
