'use client';

import { useEffect, useState } from 'react';
import { applyTheme, currentTheme, type ThemeName } from '@/lib/theme';

const options: { id: ThemeName; label: string }[] = [
  { id: 'cobalt', label: 'Cobalt' },
  { id: 'mint', label: 'Mint' },
];

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<ThemeName>('cobalt');

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function choose(next: ThemeName) {
    applyTheme(next);
    setTheme(next);
  }

  return (
    <div className={`theme-switch ${className}`} role="radiogroup" aria-label="Color palette">
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={theme === option.id}
          onClick={() => choose(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
