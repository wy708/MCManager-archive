export interface HeightPreference { minY: number; maxY: number }
const key = (id:string) => `mcmanager.project.${id}.height.v1`
export function readHeight(id:string):HeightPreference|null {
  try {
    const value=JSON.parse(localStorage.getItem(key(id)) ?? 'null')
    return value && Number.isInteger(value.minY) && Number.isInteger(value.maxY) && value.minY>=-2048 && value.maxY<=4095 && value.minY<=value.maxY ? value : null
  } catch { return null }
}
export function saveHeight(id:string,value:HeightPreference|null) {
  try { if(value)localStorage.setItem(key(id),JSON.stringify(value));else localStorage.removeItem(key(id)) } catch { /* Storage may be disabled. Viewing remains available. */ }
}
