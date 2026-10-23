// 相对时间（“3 分钟前”“上次在线”）每分钟刷新一次。

import { useEffect, useState } from 'react';

export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
