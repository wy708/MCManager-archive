import base64
import io
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from project_maps import Bounds, render

class ProjectMapTests(unittest.TestCase):
    def test_negative_coordinates_and_boundary_pixels_never_leak(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);folder=root/'Overworld/tiles/zoom-4';folder.mkdir(parents=True)
            tile=Image.new('RGBA',(256,256),'red')
            # Only the last world block in this negative-X tile belongs to the project.
            tile.paste('blue',(240,0,256,256));tile.save(folder/'(-1)-(0).png')
            result=render(root,Bounds(dimension='minecraft:overworld',minX=-1,maxX=-1,minZ=0,maxZ=15))
            image=Image.open(io.BytesIO(base64.b64decode(result['image'])))
            self.assertEqual(image.size,(16,256));self.assertEqual(set(image.getdata()),{(0,0,255,255)})
            self.assertTrue(result['metadata']['tileCoverageComplete'])
    def test_missing_tiles_remain_transparent_and_work_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            result=render(Path(temporary),Bounds(dimension='minecraft:the_end',minX=-30000000,maxX=30000000,minZ=-30000000,maxZ=30000000))
            image=Image.open(io.BytesIO(base64.b64decode(result['image'])))
            self.assertLessEqual(max(image.size),1024)
            self.assertIsNone(image.getbbox());self.assertEqual(result['metadata']['examinedTiles'],1024)
            self.assertTrue(result['metadata']['truncated'])
    def test_reversed_bounds_and_unknown_dimension_rejected(self):
        for args in [dict(dimension='../secret',minX=0,maxX=1,minZ=0,maxZ=1),dict(dimension='minecraft:overworld',minX=1,maxX=0,minZ=0,maxZ=1)]:
            with self.assertRaises(ValueError):render(Path('.'),Bounds(**args))

if __name__=='__main__':unittest.main()
