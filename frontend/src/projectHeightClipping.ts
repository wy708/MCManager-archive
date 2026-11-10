import {Plane,Vector3} from 'three'

/** Keep whole boundary blocks. An exactly coplanar GPU clipping plane can
 * discard fragments of their faces after view-space float rounding. */
export function projectHeightClipping(centerY:number,minY:number,maxY:number):Plane[] {
  const margin=0.001
  return [
    new Plane(new Vector3(0,1,0),centerY-minY+margin),
    new Plane(new Vector3(0,-1,0),maxY+1-centerY+margin),
  ]
}
