import { use, init } from 'echarts/core'
import { BarChart, LineChart, PieChart, HeatmapChart, GraphChart, SankeyChart, TreemapChart, ThemeRiverChart, ScatterChart, SunburstChart, BoxplotChart, RadarChart, CustomChart } from 'echarts/charts'
import {
  SingleAxisComponent,
  RadarComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CalendarComponent,
  VisualMapComponent,
  DataZoomComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'

use([
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  GraphChart,
  SankeyChart,
  TreemapChart,
  ThemeRiverChart, ScatterChart, SunburstChart, BoxplotChart, RadarChart, CustomChart,
  SingleAxisComponent, RadarComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CalendarComponent,
  VisualMapComponent,
  DataZoomComponent,
  SVGRenderer,
])
export { init }
