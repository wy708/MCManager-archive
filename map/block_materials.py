"""Bedrock state-aware top-view textures for the original MipMap renderer.

State without a top-view visual effect intentionally shares the same material.
Unknown namespaces never silently borrow a vanilla block with the same suffix.
"""
import json
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path('assets/bedrock')
CATALOG = json.loads((ROOT / 'catalog.json').read_text(encoding='utf-8'))
DEFINITIONS = CATALOG['definitions']
TEXTURES = CATALOG['textures']
ALIASES = {'grass_block': 'grass', 'iron_chain': 'chain', 'oak_trapdoor': 'trapdoor', 'underwater_tnt': 'tnt',
           'underwater_torch': 'torch', 'piston_arm_collision': 'piston',
           'sticky_piston_arm_collision': 'sticky_piston', 'shelf_mushroom': 'brown_mushroom'}
INVISIBLE = {'air', 'cave_air', 'void_air', 'structure_void', 'light_block', 'barrier', 'chemical_heat'}
DOORS = ['wooden', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'iron']


def material(name, states):
    """Return atlas key, array index, clockwise quarter turns, and geometry kind."""
    name = name.removeprefix('minecraft:')
    if ':' in name:
        return None, 0, 0, ''
    original = name
    if name.startswith('hard_') and ('glass' in name):
        name = name[5:]
    if name.startswith('colored_torch_'):
        name = 'torch'
    name = ALIASES.get(name, name)
    definition = DEFINITIONS.get(name, {})
    faces = definition.get('textures', name)
    key = faces.get('up', faces.get('side', '')) if isinstance(faces, dict) else faces
    s = {k.removeprefix('minecraft:'): v for k, v in states.items()}
    get = lambda k, default=0: s.get(k, default)
    number = lambda k, default=0: int(get(k, default)) if isinstance(get(k, default), (int, bool)) else default
    index, turns, kind = 0, 0, ''
    cardinal = get('cardinal_direction', '')
    turns = {'north': 0, 'east': 1, 'south': 2, 'west': 3}.get(cardinal, 0)
    if not cardinal:
        turns = number('direction') % 4
    if name in INVISIBLE:
        return '__transparent', 0, 0, ''
    if name.endswith('_rail') or name == 'rail':
        shape = number('rail_direction')
        if name == 'rail':
            key = 'rail_normal_turned' if shape >= 6 else 'rail_normal'
        else:
            prefix = {'golden_rail': 'rail_golden', 'detector_rail': 'rail_detector',
                      'activator_rail': 'rail_activator'}.get(name, 'rail_normal')
            key = prefix + ('_powered' if get('rail_data_bit') else '')
        turns = {0: 0, 1: 1, 2: 1, 3: 1, 4: 0, 5: 0, 6: 0, 7: 1, 8: 2, 9: 3}.get(shape, 0)
    elif name in ('wheat', 'carrots', 'potatoes', 'beetroot'):
        growth = number('growth')
        index = growth if name == 'wheat' else (3 if growth >= 7 else min(2, growth // 2))
    elif name in ('nether_wart', 'cocoa', 'frosted_ice', 'chorus_flower'):
        index = (int(number('age') >= 5) if name == 'chorus_flower' else number('age'))
    elif name == 'torchflower_crop':
        index = min(1, number('growth'))
    elif name == 'pitcher_crop':
        if number('growth') >= 3:
            key = 'pitcher_crop_upper_flower' if get('upper_block_bit') else 'pitcher_crop_lower_flower'
        else:
            key = 'pitcher_crop_top' if number('growth') == 0 else 'pitcher_crop_side'
    elif name == 'big_dripleaf':
        key = 'big_dripleaf_top' if get('big_dripleaf_head', True) else 'big_dripleaf_stem'
        kind = 'tilted_leaf' if get('big_dripleaf_tilt') in ('partial_tilt', 'full_tilt') else ''
    elif name == 'seagrass':
        key = {'default': 'seagrass_short', 'double_bot': 'seagrass_tall_bot_a',
               'double_top': 'seagrass_tall_top_a'}.get(get('sea_grass_type'), 'seagrass_short')
    elif name in ('campfire', 'soul_campfire'):
        key = 'campfire_log' if get('extinguished') else name + '_log_lit'
    elif name == 'end_portal_frame':
        key = 'endframe_eye' if get('end_portal_eye_bit') else 'endframe_top'
    elif name == 'cake':
        kind = 'cake'
    elif name in ('suspicious_sand', 'suspicious_gravel'):
        index = number('brushed_progress')
    elif name == 'farmland':
        index = int(number('moisturized_amount') > 0)
    elif 'copper_bulb' in name:
        index = int(bool(get('lit'))) + 2 * int(bool(get('powered_bit')))
    elif 'lightning_rod' in name:
        index = int(bool(get('powered_bit')))
    elif name.endswith('candle'):
        index, kind = int(bool(get('lit'))), 'candle'
    elif name.endswith('_door') or name == 'wooden_door':
        if key == 'door_lower':
            index = DOORS.index(name.removesuffix('_door'))
        kind = 'door'
        turns = (turns + (1 if get('door_hinge_bit') else -1) * int(bool(get('open_bit')))) % 4
    elif name.endswith('trapdoor'):
        kind = 'door' if get('open_bit') else ''
    elif name.endswith('fence_gate'):
        kind = 'gate_open' if get('open_bit') else 'gate'
    elif 'repeater' in name or 'comparator' in name:
        index = int(name.startswith('powered_') or bool(get('output_lit_bit')))
    elif name == 'daylight_detector_inverted':
        index = 1
    elif name.startswith('cave_vines'):
        index = int('with_berries' in name)
    elif name in ('turtle_egg', 'sniffer_egg'):
        index = {'no_cracks': 0, 'cracked': 1, 'max_cracked': 2}.get(get('cracked_state'), 0)
    elif name == 'respawn_anchor':
        index = number('respawn_anchor_charge')
    elif name == 'trial_spawner':
        index = number('trial_spawner_state') + 6 * int(bool(get('ominous')))
    elif name == 'vault':
        index = {'inactive': 0, 'active': 1, 'unlocking': 2, 'ejecting': 3}.get(get('vault_state'), 0) + 4 * int(bool(get('ominous')))
    elif name == 'crafter':
        index = 2 if get('crafting') else int(bool(get('triggered_bit')))
    elif name == 'creaking_heart':
        index = {'uprooted': 0, 'dormant': 1, 'awake': 2}.get(get('creaking_heart_state'), 0)
    elif name == 'dried_ghast':
        index = number('rehydration_level')
    elif name == 'sculk_catalyst':
        index = int(bool(get('bloom')))
    elif name == 'mangrove_propagule':
        index = int(bool(get('hanging')))
    elif name in ('melon_stem', 'pumpkin_stem'):
        index = int(number('facing_direction', 7) != 7)
    elif name in ('pointed_dripstone', 'sulfur_spike'):
        thickness = get('dripstone_thickness', 'base')
        prefix = name + '_' + {'merge': 'merge', 'tip': 'tip', 'frustum': 'frustum', 'middle': 'middle', 'base': 'base'}.get(thickness, 'base')
        key = prefix if prefix in TEXTURES else key
        index = int(bool(get('hanging')))
    elif name == 'structure_block':
        index = {'data': 0, 'save': 1, 'load': 2, 'corner': 3, 'invalid': 4, 'export': 5}.get(get('structure_block_type'), 0)
    elif name in ('brown_mushroom_block', 'red_mushroom_block', 'mushroom_stem'):
        index = number('huge_mushroom_bits')
    elif name == 'composter':
        level = number('composter_fill_level')
        index = 2 if level == 8 else int(level > 0)
    elif name == 'pale_hanging_moss':
        index = int(bool(get('tip')))
    elif name == 'bubble_column':
        key = 'bubble_column_down_top' if get('drag_down') else 'bubble_column_up_top'
    # Horizontal logs expose bark, vertical logs expose the cut end.
    axis = get('pillar_axis', 'y')
    if axis in ('x', 'z') and isinstance(faces, dict):
        key = faces.get('side', key)
        turns = 1 if axis == 'x' else 0
    facing = {'down': 0, 'up': 1, 'north': 2, 'south': 3, 'west': 4, 'east': 5}.get(get('facing_direction'), number('facing_direction', 2))
    if name in ('piston', 'sticky_piston'):
        key = ('piston_top_sticky' if name == 'sticky_piston' else 'piston_top_normal') if facing == 1 else 'piston_bottom' if facing == 0 else 'piston_side'
        turns = {2: 0, 3: 2, 4: 3, 5: 1}.get(facing, 0)
    elif name in ('observer', 'dispenser', 'dropper') and isinstance(faces, dict):
        key = faces.get('south', key) if facing == 1 else faces.get('down', key) if facing == 0 else key
        turns = {2: 0, 3: 2, 4: 3, 5: 1}.get(facing, 0)
    if name == 'redstone_wire':
        kind = 'redstone'
    if get('upper_block_bit') is False and isinstance(faces, dict) and ('grass' in name or name in ('sunflower', 'lilac', 'peony', 'rose_bush', 'large_fern', 'pitcher_plant')):
        key = faces.get('down', key)
    if name.endswith('stairs'):
        turns = {0: 1, 1: 3, 2: 2, 3: 0}.get(number('weirdo_direction'), 0)
        kind = 'stairs' if not get('upside_down_bit') else ''
    # Legacy identifiers remain readable without states; new names use the atlas.
    return key, max(0, index), turns, kind


@lru_cache(maxsize=8192)
def _render(name, state_pairs):
    states = dict(state_pairs)
    key, index, turns, kind = material(name, states)
    if key == '__transparent':
        return Image.new('RGBA', (16, 16))
    choices = TEXTURES.get(key, [])
    path = choices[min(index, len(choices) - 1)] if choices else None
    if not path:
        return None
    with Image.open(ROOT / path) as source:
        image = source.convert('RGBA')
    bare = name.removeprefix('minecraft:')
    if key and 'water_grey' in key:
        alpha = image.getchannel('A')
        image = ImageChops.multiply(image, Image.new('RGBA', image.size, (48, 112, 230, 255)))
        image.putalpha(alpha)
    if (key in ('grass_top', 'tall_grass_top', 'tall_grass_bottom', 'fern', 'vine') or
            ('leaves' in key and not any(x in key for x in ('cherry', 'pale', 'poplar')))):
        # Bedrock applies a biome tint in its renderer. No biome data is collected:
        # use the default plains tint, never display the untinted grey source art.
        tint = (97, 153, 97) if 'spruce' in key else (128, 167, 85) if 'birch' in key else (145, 189, 89)
        alpha = image.getchannel('A')
        image = ImageChops.multiply(image, Image.new('RGBA', image.size, tint + (255,)))
        image.putalpha(alpha)
    if kind == 'redstone':
        strength = int(states.get('redstone_signal', 0))
        # The vanilla dust texture is greyscale and is colored by the game engine.
        color = (76 + strength * 11, max(0, strength - 9) * 9, 0)
        image = Image.new('RGBA', (16, 16), color + (255,))
        with Image.open(ROOT / path) as source:
            image.putalpha(source.convert('RGBA').getchannel('A'))
    if kind in ('door', 'gate', 'gate_open'):
        panel = image.resize((16, 3), Image.Resampling.NEAREST)
        image = Image.new('RGBA', (16, 16))
        if kind == 'gate_open':
            image.paste(panel.crop((0, 0, 3, 3)), (0, 6))
            image.paste(panel.crop((0, 0, 3, 3)), (13, 6))
        else:
            image.paste(panel, (0, 0 if kind == 'door' else 6))
    if kind == 'candle':
        count = int(states.get('candles', 0)) + 1
        mini = image.resize((4, 4), Image.Resampling.NEAREST)
        image = Image.new('RGBA', (16, 16))
        for x, y in [(3, 3), (9, 9), (3, 9), (9, 3)][:count]:
            image.paste(mini, (x, y))
    if kind == 'cake':
        bites = min(6, max(0, int(states.get('bite_counter', 0))))
        image.paste((0, 0, 0, 0), (0, 0, bites * 2, 16))
    if kind == 'tilted_leaf':
        resized = image.resize((16, 5), Image.Resampling.NEAREST)
        image = Image.new('RGBA', (16, 16))
        image.paste(resized, (0, 5))
    if kind == 'stairs':
        # A top-down step boundary; corner/height geometry stays 2D like upstream.
        lower = image.crop((0, 0, 16, 8))
        lower = ImageChops.multiply(lower, Image.new('RGBA', lower.size, (205, 205, 205, 255)))
        image.paste(lower, (0, 0))
    return image.rotate(-90 * turns, resample=Image.Resampling.NEAREST)


def texture_for(block):
    return _render(block.name, tuple(sorted(getattr(block, 'states', {}).items())))
