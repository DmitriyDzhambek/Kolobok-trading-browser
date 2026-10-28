const API_BASE = (import.meta.env.VITE_KOLOBOK_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

export async function getKolobokBackendStatus(signal) {
  const response = await fetch(`${API_BASE}/api/status`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal
  });
  if (!response.ok) throw new Error(`Kolobok backend returned ${response.status}`);
  return response.json();
}

export async function getKolobokBackendHealth(signal) {
  const response = await fetch(`${API_BASE}/health`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Kolobok backend returned ${response.status}`);
  return response.json();
}
