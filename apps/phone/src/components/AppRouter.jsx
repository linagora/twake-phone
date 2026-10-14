import React from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'

import AppLayout from '@/components/AppLayout'
import { Dialer } from '@/components/Views/Dialer'
import { Meetings } from '@/components/Views/Meetings'
import { Recents } from '@/components/Views/Recents'

const AppRouter = () => {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/dialer" element={<Dialer />}></Route>
          <Route path="/recents" element={<Recents />}></Route>
          <Route path="/meetings" element={<Meetings />}></Route>
          <Route path="*" element={<Navigate replace to="/dialer" />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}

export default AppRouter
