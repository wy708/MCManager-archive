import unittest
from types import SimpleNamespace
from nether_capture import scan_column, NetherCapture

def sample_column(world,x,z,blacklist):
    return list(scan_column(world,x,z,blacklist))[-1]


class NetherTest(unittest.TestCase):
    def world(self, layers):
        def get(x, y, z):
            name = layers.get(y, 'netherrack')
            return SimpleNamespace(data=SimpleNamespace(type='minecraft:'+name, block_states={}))
        return SimpleNamespace(get_block_at=get)

    def test_skips_roof_and_ceiling_and_rejects_one_block_pocket(self):
        world = self.world({126: 'bedrock', 119: 'air', 80: 'air', 79: 'air', 78: 'air', 77: 'lava'})
        result = sample_column(world, 2, 3, set())
        self.assertEqual(result['cavities'][0]['name'], 'minecraft:lava')
        self.assertEqual(result['cavities'][0]['coordinates'], [2, 77, 3])

    def test_solid_column_is_transparent_not_a_fake_floor(self):
        self.assertEqual(sample_column(self.world({}), 0, 0, set())['name'], 'minecraft:air')

    def test_blacklist_below_air_still_applies(self):
        world = self.world({70: 'air', 69: 'air', 68: 'brown_mushroom'})
        self.assertEqual(sample_column(world, 0, 0, {'minecraft:brown_mushroom'})['cavities'][0]['coordinates'][1], 67)

    def test_cave_floor_retains_transparent_decorations_and_ground(self):
        world = self.world({80:'air',79:'air',78:'torch',77:'red_stained_glass'})
        cave = sample_column(world, 2, 3, set())['cavities'][0]
        self.assertEqual(cave['name'],'minecraft:torch')
        self.assertEqual([b['name'] for b in cave['layers']],['minecraft:red_stained_glass','minecraft:netherrack'])
        self.assertEqual(cave['layers'][-1]['coordinates'],[2,76,3])

    def test_capture_is_sliced_and_unloaded_chunks_are_discarded(self):
        world = self.world({80:'air',79:'air'})
        world.loaded_chunks = [SimpleNamespace(x=0,z=0)]
        sent = []
        plugin = SimpleNamespace(config={}, _chunksQueue=SimpleNamespace(put=sent.append), server=SimpleNamespace(current_tps=20,current_mspt=5,online_players=[],level=SimpleNamespace(get_dimension=lambda _:world)))
        scan = NetherCapture(plugin)
        scan.enqueue(world.loaded_chunks[0])
        scan.step()
        self.assertEqual(len(sent),0)
        self.assertLessEqual(scan.reads,512)
        while not sent: scan.step()
        self.assertEqual(len(sent[0]['chunk']['blocks']),256)
        scan.enqueue(world.loaded_chunks[0])
        world.loaded_chunks=[]
        scan.step()
        self.assertFalse(scan.pending)


if __name__ == '__main__': unittest.main()
