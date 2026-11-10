"""Add bounded, same-column underlays to the pinned (already patched) MipMap web."""
from pathlib import Path
import sys
root = Path(sys.argv[1]) if len(sys.argv)>1 else Path('/app')
model = root/'models/chunk.py'
text = model.read_text()
assert 'class Underlay' not in text
text = text.replace('StrictStr', 'StrictStr, model_validator', 1)
underlay = '''class Underlay(BaseModel):
    name: str = Field(max_length=128)
    coordinates: Tuple[StrictInt, StrictInt, StrictInt]
    states: dict[str, StrictBool | StrictInt | StrictStr] = Field(default_factory=dict)

class LayeredColumn(BaseModel):
    layers: list[Underlay] = Field(default_factory=list, max_length=63)
    layers_complete: bool = True

    @model_validator(mode='after')
    def same_column(self):
        x, y, z = self.coordinates
        for layer in self.layers:
            lx, ly, lz = layer.coordinates
            if lx != x or lz != z or ly >= y or ly < -64:
                raise ValueError('Underlays must descend in the same world column')
            y = ly
        return self

'''
text = text.replace('class Cavity(BaseModel):',underlay+'class Cavity(LayeredColumn):').replace('class BlockData(BaseModel):','class BlockData(LayeredColumn):')
model.write_text(text)
renderer = root/'services/tileGenerator.py'
text = renderer.read_text()
text = text.replace('from services.block_materials import texture_for','from services.block_materials import texture_for\nfrom services.surface_composite import render_column, ground_height')
text = text.replace('heightMap[tileKey][blockKey] = block.y','heightMap[tileKey][blockKey] = ground_height(block)')
start = text.index('                texture = self._textureLoader.getTexture(block)')
end = text.index('                tileMap[tileKey].paste(heightTexture, blockKey)',start)
text = text[:start]+'                heightTexture = render_column(self, block, blockKey, heightMap[tileKey])\n'+text[end:]
renderer.write_text(text)
