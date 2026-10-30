import React from 'react'
import { Outlet } from 'react-router-dom'

import { BarComponent } from 'cozy-bar'

const AppLayout = () => (
  <>
    <BarComponent searchOptions={{ enabled: false }} componentsProps={{ CozyTheme: { type: 'light' } }} />
    <Outlet />
  </>
)

export default AppLayout
