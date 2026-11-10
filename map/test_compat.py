"""Regression checks for the reported missing texture and stale zoom pyramid."""
import os
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from models.chunk import BlockData
from services.tileGenerator import TextureLoader
from services.map_compat import save_tiles
from services.block_materials import texture_for, material, ROOT, TEXTURES


class CompatibilityTest(unittest.TestCase):
    def test_powered_rail_uses_its_real_texture(self):
        texture = TextureLoader().getTexture(BlockData(name='minecraft:golden_rail', coordinates=(0, 100, 0)))
        with Image.open(ROOT / TEXTURES['rail_golden'][0]) as expected:
            self.assertEqual(texture.convert('RGBA').tobytes(), expected.convert('RGBA').tobytes())

    def texture(self, name, **states):
        return TextureLoader().getTexture(BlockData(name='minecraft:' + name, states=states, coordinates=(0, 100, 0))).tobytes()

    def test_furnace_lit_and_unlit_share_the_correct_top(self):
        self.assertEqual(self.texture('furnace'), self.texture('lit_furnace'))
        self.assertEqual(material('lit_furnace', {})[0], 'furnace_top')

    def test_visual_state_changes(self):
        pairs = [('golden_rail', {'rail_data_bit': False}, {'rail_data_bit': True}),
                 ('rail', {'rail_direction': 0}, {'rail_direction': 6}),
                 ('wheat', {'growth': 0}, {'growth': 7}),
                 ('carrots', {'growth': 2}, {'growth': 7}),
                 ('copper_bulb', {'lit': False}, {'lit': True}),
                 ('farmland', {'moisturized_amount': 0}, {'moisturized_amount': 7}),
                 ('oak_log', {'pillar_axis': 'y'}, {'pillar_axis': 'x'}),
                 ('oak_trapdoor', {'open_bit': False}, {'open_bit': True}),
                 ('spruce_door', {'open_bit': False}, {'open_bit': True}),
                 ('redstone_wire', {'redstone_signal': 0}, {'redstone_signal': 15}),
                 ('trial_spawner', {'trial_spawner_state': 0}, {'trial_spawner_state': 1}),
                 ('cake', {'bite_counter': 0}, {'bite_counter': 4}),
                 ('campfire', {'extinguished': False}, {'extinguished': True})]
        for name, before, after in pairs:
            with self.subTest(name=name):
                self.assertNotEqual(self.texture(name, **before), self.texture(name, **after))

    def test_mod_namespace_cannot_be_mistaken_for_vanilla(self):
        self.assertIsNone(texture_for(BlockData(name='custom:furnace', coordinates=(0, 0, 0))))

    def test_water_receives_game_tint_instead_of_grey_source(self):
        texture = texture_for(BlockData(name='minecraft:water', coordinates=(0, 100, 0)))
        red, green, blue, alpha = texture.getpixel((8, 8))
        self.assertGreater(blue, red)
        self.assertGreater(blue, green)

    def test_payload_keeps_boolean_integer_and_string_states(self):
        block = BlockData(name='minecraft:golden_rail', coordinates=(0, 0, 0), states={'rail_data_bit': True, 'rail_direction': 1, 'minecraft:cardinal_direction': 'east'})
        self.assertIs(block.states['rail_data_bit'], True)
        self.assertIs(type(block.states['rail_direction']), int)
        self.assertEqual(block.states['minecraft:cardinal_direction'], 'east')

    def test_positive_and_negative_updates_reach_every_zoom_immediately(self):
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as temporary:
            try:
                os.chdir(temporary)
                leaf = Path('data/worlds/Overworld/tiles/zoom-4')
                leaf.mkdir(parents=True)
                save_tiles({(-1, -1): Image.new('RGBA', (256, 256), 'red'),
                            (0, 0): Image.new('RGBA', (256, 256), 'green')}, leaf)
                for level in range(4):
                    parent = leaf.parent / f'zoom-{level}'
                    with Image.open(parent / '(-1)-(-1).png') as negative:
                        point = 256 - 128 // (2 ** (4 - level))
                        self.assertGreater(negative.getpixel((point, point))[0], 200)
                    with Image.open(parent / '(0)-(0).png') as positive:
                        point = 128 // (2 ** (4 - level))
                        self.assertGreater(positive.getpixel((point, point))[1], 80)
                save_tiles({(-1, -1): Image.new('RGBA', (256, 256), 'blue')}, leaf)
                for level in range(4):
                    with Image.open(leaf.parent / f'zoom-{level}' / '(-1)-(-1).png') as image:
                        point = 256 - 128 // (2 ** (4 - level))
                        self.assertEqual(image.getpixel((point, point)), (0, 0, 255, 255))
            finally:
                os.chdir(old)


if __name__ == '__main__':
    unittest.main()
