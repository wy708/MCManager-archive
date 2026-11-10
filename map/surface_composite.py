"""Replace each column with freshly composited, observed layers (no stale pixels)."""
from PIL import Image

def ground_height(block):
    return block.layers[-1].coordinates[1] if block.layers else block.y

def render_column(renderer, block, position, heights):
    image = Image.new('RGBA', (16, 16))
    for layer in reversed([block, *block.layers]):
        texture = renderer._textureLoader.getTexture(layer).convert('RGBA')
        shaded = renderer._applyHeightShading(texture, layer.coordinates[1], position, heights)
        # Height tints and contour lines must never fill transparent texels.
        shaded.putalpha(texture.getchannel('A'))
        image = Image.alpha_composite(image, shaded)
    return image
