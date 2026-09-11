import { useCallback, useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'

const KEY = 'am.theme'

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    // a private window, or storage blocked entirely
    return 'system'
  }
}

/**
 * Apply the choice to the document root.
 *
 * "system" removes the attribute rather than setting it to anything, because
 * following the operating system means having no opinion — the CSS falls back
 * to prefers-color-scheme on its own.
 */
function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = theme
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setState] = useState<Theme>(stored)

  useEffect(() => {
    apply(theme)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setState(next)
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      // the choice still applies for this session
    }
  }, [])

  return { theme, setTheme }
}
