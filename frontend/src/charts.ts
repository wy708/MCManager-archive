import { use, init } from 'echarts/core'
import { BarChart, LineChart, PieChart, HeatmapChart, GraphChart, SankeyChart, TreemapChart, ScatterChart, SunburstChart, BoxplotChart, RadarChart, CustomChart } from 'echarts/charts'
import {
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
  ScatterChart, SunburstChart, BoxplotChart, RadarChart, CustomChart,
  RadarComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CalendarComponent,
  VisualMapComponent,
  DataZoomComponent,
  SVGRenderer,
])
export { init }
