import unittest
from cave_layers import connected_floors


def cave(low, high, floor):
    return {'low': low, 'high': high, 'coordinates':[0,floor,0], 'name':'minecraft:netherrack','states':{}}


class CaveTest(unittest.TestCase):
    def test_connected_floor_does_not_jump_to_disconnected_upper_cave(self):
        columns = {(15,0):[cave(40,70,39)], (16,0):[cave(80,110,79),cave(45,69,44)],
                   (17,0):[cave(47,60,46)], (18,0):[cave(90,110,89)]}
        result = connected_floors(columns,64)
        self.assertEqual(result[16,0]['coordinates'][1],44)
        self.assertEqual(result[17,0]['coordinates'][1],46)
        self.assertNotIn((18,0),result)
        upper = connected_floors(columns,96)
        self.assertEqual(upper[16,0]['coordinates'][1],79)
        self.assertNotIn((15,0),upper)

    def test_one_block_overlap_is_not_two_block_passage(self):
        result = connected_floors({(0,0):[cave(40,64,39)],(1,0):[cave(30,40,29)]},60)
        self.assertNotIn((1,0),result)

    def test_graph_uses_only_collected_columns(self):
        self.assertEqual(connected_floors({},64),{})


if __name__ == '__main__': unittest.main()
