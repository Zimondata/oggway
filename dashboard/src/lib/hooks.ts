import { useState, useEffect, useCallback, useRef } from 'react';
import type { DashboardData, CostsData, IncidentsData } from './types';

// ── Generic fetch hook ──

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFetch<T>(
  url: string,
  refreshInterval = 30_000,
): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: T) => {
        setData(json);
        setError(null);
      })
      .catch((e: Error) => {
        setError(e.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [url]);

  useEffect(() => {
    fetchData();

    if (refreshInterval > 0) {
      intervalRef.current = setInterval(fetchData, refreshInterval);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, refreshInterval]);

  return { data, loading, error, refetch: fetchData };
}

// ── Composed API hook ──

export function useApi(period: '7d' | '30d') {
  const stats = useFetch<DashboardData>(`/api/stats?period=${period}`);
  const costs = useFetch<CostsData>(`/api/costs?period=${period}`);
  const incidents = useFetch<IncidentsData>('/api/incidents');

  const loading = stats.loading || costs.loading || incidents.loading;

  const refetchAll = useCallback(() => {
    stats.refetch();
    costs.refetch();
    incidents.refetch();
  }, [stats.refetch, costs.refetch, incidents.refetch]);

  return {
    stats: stats.data,
    costs: costs.data,
    incidents: incidents.data,
    loading,
    error: stats.error || costs.error || incidents.error,
    refetchAll,
  };
}
