'use client';
import { useEffect, useRef } from 'react';

export function deadlineDelay(deadline: string, now = Date.now()) {
  const remaining = Date.parse(deadline) - now + 1000;
  return Number.isFinite(remaining) ? Math.min(2147483647, Math.max(1000, remaining)) : null;
}
// One scheduled refresh, no login and no interval polling. Cleanup also handles unmounts.
export function useDeadlineRefresh(deadline: string | null | undefined, refresh: () => void) {
  const fired = useRef<string | null>(null);
  useEffect(() => {
    if (!deadline) {
      fired.current = null;
      return;
    }
    if (fired.current === deadline) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = deadlineDelay(deadline);
      if (delay === null) return;
      timer = setTimeout(() => {
        if (Date.parse(deadline) > Date.now()) schedule();
        else {
          fired.current = deadline;
          refresh();
        }
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [deadline, refresh]);
}
