import unittest
from PIL import Image
from pydantic import ValidationError
from models.chunk import BlockData
from services.tileGenerator import TileRenderer
from services.surface_composite import render_column, ground_height

class CompositionTest(unittest.TestCase):
    def test_transparency_keeps_actual_ground_and_no_black_square(self):
        renderer=TileRenderer()
        for name in ['torch','soul_torch','dandelion','poppy','wheat','glass','red_stained_glass','glass_pane','blue_stained_glass_pane','oak_leaves','golden_rail','water']:
            with self.subTest(name=name):
                ground=BlockData(name='minecraft:sand',coordinates=(0,100,0))
                block=BlockData(name='minecraft:'+name,coordinates=(0,101,0),layers=[ground.model_dump()])
                heights={(0,0):100}
                actual=render_column(renderer,block,(0,0),heights)
                self.assertEqual(actual.getchannel('A').getextrema(),(255,255))
                texture=renderer._textureLoader.getTexture(block)
                below=render_column(renderer,ground,(0,0),heights)
                for x in range(16):
                    for z in range(16):
                        if texture.getpixel((x,z))[3]==0:self.assertEqual(actual.getpixel((x,z)),below.getpixel((x,z)))
                self.assertNotEqual(actual.tobytes(),below.tobytes())
                self.assertEqual(ground_height(block),100)
    def test_old_payload_is_accepted_without_invented_underlay(self):
        block=BlockData(name='minecraft:torch',coordinates=(0,100,0))
        self.assertEqual(block.layers,[])
        self.assertEqual(render_column(TileRenderer(),block,(0,0),{}).getchannel('A').getextrema()[0],0)
    def test_underlays_cannot_escape_column_or_reverse_order(self):
        for xyz in [(1,99,0),(0,101,0),(0,-65,0)]:
            with self.assertRaises(ValidationError):BlockData(name='minecraft:glass',coordinates=(0,100,0),layers=[{'name':'minecraft:stone','coordinates':xyz}])
    def test_new_column_replaces_old_pixels_after_removal(self):
        from models.chunk import ChunkData
        renderer=TileRenderer();saved={}
        renderer._loadTile=lambda _:saved.get('image',Image.new('RGBA',(256,256)))
        renderer._saveTiles=lambda tiles,_:saved.update(image=tiles[(0,0)])
        glass=BlockData(name='minecraft:red_stained_glass',coordinates=(0,101,0),layers=[{'name':'minecraft:stone','coordinates':(0,100,0)}])
        renderer.generateTile(ChunkData(dimension='Overworld',blocks=[glass]))
        before=saved['image'].tobytes()
        ground=BlockData(name='minecraft:sand',coordinates=(0,100,0))
        renderer.generateTile(ChunkData(dimension='Overworld',blocks=[ground]))
        self.assertNotEqual(saved['image'].tobytes(),before)
        expected=render_column(renderer,ground,(0,0),{(0,0):100})
        self.assertEqual(saved['image'].crop((0,0,16,16)).tobytes(),expected.tobytes())
if __name__=='__main__':unittest.main()
