import { useEffect, useState } from 'react'

/** The current time, refreshed every second (for call timers). */
export const useNow = () => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
