import { useCallback, useEffect, useState } from 'react';

// Loads data from an API call and reloads when `deps` change. Returns { data, error, loading, reload }.
export default function useApi(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, error: '', loading: true });

  const load = useCallback(fetcher, deps); // the caller lists what the fetcher depends on

  const reload = useCallback(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: '' }));
    load()
      .then((data) => !cancelled && setState({ data, error: '', loading: false }))
      .catch((err) => !cancelled && setState({ data: null, error: err.message, loading: false }));
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(reload, [reload]);
  return { ...state, reload };
}
