import { createApp } from 'vue'
import App from './App.vue'
import PublicProjectView from './components/PublicProjectView.vue'
import './style.css'
import './statistics.css'
import './adventure.css'
import './reference.css'

const project = /^\/projects\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/?$/i.exec(
  window.location.pathname,
)
if (project) createApp(PublicProjectView, { id: project[1]! }).mount('#app')
else createApp(App).mount('#app')

import './garden.css'
