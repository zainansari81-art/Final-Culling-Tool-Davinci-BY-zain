import { BrowserRouter, Routes, Route } from 'react-router-dom'
import HomePage from './pages/HomePage'
import JobPage from './pages/JobPage'
import SequencePage from './pages/SequencePage'
import SettingsPage from './pages/SettingsPage'
import PushPage from './pages/PushPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/jobs/:id" element={<JobPage />} />
        <Route path="/jobs/:id/sequence" element={<SequencePage />} />
        <Route path="/jobs/:id/push" element={<PushPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  )
}
