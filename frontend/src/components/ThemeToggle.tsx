// The light/dark switch at the right end of the header: a moon in light
// mode, a sun in dark mode, each showing what a click switches to.

function SunIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M3.05 12.95l1.13-1.13M11.82 4.18l1.13-1.13" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" />
    </svg>
  )
}

interface ThemeToggleProps {
  isDarkMode: boolean
  onChange: (isDarkMode: boolean) => void
}

export function ThemeToggle({ isDarkMode, onChange }: ThemeToggleProps) {
  const label = isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => onChange(!isDarkMode)}
      title={label}
      aria-label={label}
    >
      {isDarkMode ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
