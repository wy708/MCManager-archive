"""Private cropped project images; never return tiles outside the chosen bounds."""
import base64
import io
import math
import time
from pathlib import Path
from PIL import Image
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

class Bounds(BaseModel):
    dimension: str
    minX: int = Field(ge=-30000000, le=30000000)
    maxX: int = Field(ge=-30000000, le=30000000)
    minZ: int = Field(ge=-30000000, le=30000000)
    maxZ: int = Field(ge=-30000000, le=30000000)

def render(root: Path, bounds: Bounds):
    layer = {'minecraft:overworld':'Overworld', 'minecraft:nether':'Nether_64', 'minecraft:the_end':'TheEnd'}.get(bounds.dimension)
    if layer is None or bounds.minX > bounds.maxX or bounds.minZ > bounds.maxZ:
        raise ValueError('Invalid project bounds')
    width, height = bounds.maxX - bounds.minX + 1, bounds.maxZ - bounds.minZ + 1
    scale = min(16, 1024 / max(width, height))
    size = (max(1, math.ceil(width * scale)), max(1, math.ceil(height * scale)))
    # Zoom 4 is 16 pixels/block; each lower level doubles the world tile span.
    zoom = min(4, max(0, math.ceil(math.log2(scale))))
    span = 256 / (2 ** zoom)
    image = Image.new('RGBA', size, (0, 0, 0, 0))
    x0, x1 = math.floor(bounds.minX/span), math.floor(bounds.maxX/span)
    z0, z1 = math.floor(bounds.minZ/span), math.floor(bounds.maxZ/span)
    total = (x1-x0+1)*(z1-z0+1)
    examined = found = 0
    newest = oldest = None
    # Fixed work budget even for coordinates spanning an entire world.
    for z in range(z0, z1+1):
        if examined >= 1024: break
        for x in range(x0, x1+1):
            if examined >= 1024: break
            examined += 1
            path = root / layer / 'tiles' / f'zoom-{zoom}' / f'({x})-({z}).png'
            try:
                stamp = path.stat().st_mtime
                with Image.open(path) as tile:
                    if tile.size != (256, 256): continue
                    # Clip first, then resize: even boundary interpolation must not expose outside blocks.
                    left, top = max(bounds.minX,x*span), max(bounds.minZ,z*span)
                    right, bottom = min(bounds.maxX+1,(x+1)*span), min(bounds.maxZ+1,(z+1)*span)
                    px = 256/span
                    crop = tile.convert('RGBA').crop((math.ceil((left-x*span)*px), math.ceil((top-z*span)*px), math.floor((right-x*span)*px), math.floor((bottom-z*span)*px)))
                    dx, dy = round((left-bounds.minX)*scale), round((top-bounds.minZ)*scale)
                    ex, ey = round((right-bounds.minX)*scale), round((bottom-bounds.minZ)*scale)
                    if ex > dx and ey > dy and crop.width and crop.height:
                        image.paste(crop.resize((ex-dx,ey-dy),Image.Resampling.NEAREST),(dx,dy))
                    found += 1
                    newest = stamp if newest is None else max(stamp,newest)
                    oldest = stamp if oldest is None else min(stamp,oldest)
            except (OSError, ValueError):
                continue
    output = io.BytesIO(); image.save(output,format='PNG')
    return {'image':base64.b64encode(output.getvalue()).decode(), 'metadata':{
        'bounds':bounds.model_dump(), 'width':size[0], 'height':size[1], 'layer':layer,
        'zoom':zoom, 'foundTiles':found, 'expectedTiles':total, 'examinedTiles':examined,
        'truncated':examined < total, 'tileCoverageComplete':found==total,
        'oldestTileModifiedAt':oldest, 'newestTileModifiedAt':newest,
        'capturedAt':time.time(), 'notice':'仅显示所选水平范围；透明区域尚未采集。下界为已有的 64 层洞穴地图。采集时间可能早于封存时间。'}}

@router.post('/internal/project-map')
def project_map(bounds: Bounds):
    from core.config import WORLDS_DIR
    try: return render(WORLDS_DIR, bounds)
    except ValueError as error: raise HTTPException(400, str(error))
