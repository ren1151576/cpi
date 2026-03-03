/*
Run this in browser DevTools console on http://localhost:8317
No token input is needed when your current page already has auth session.
*/

(() => {
  const BASE_URL = window.location.origin;
  const STATUS_VALUE = "error";
  const DRY_RUN = false;

  const normalizeFiles = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.files)) return payload.files;
    throw new Error("No files array found in response.");
  };

  const requestJson = async (method, path) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: { Accept: "application/json" }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
    }

    if (res.status === 204) return null;
    return res.json();
  };

  const requestDelete = async (path) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "DELETE",
      credentials: "include"
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DELETE ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
  };

  (async () => {
    console.log(`[clean-script] Listing auth files from ${BASE_URL} ...`);
    const payload = await requestJson("GET", "/v0/management/auth-files");
    const files = normalizeFiles(payload);
    const targets = files.filter((x) => x && x.name && x.status === STATUS_VALUE);

    if (targets.length === 0) {
      console.log(`[clean-script] No files found with status='${STATUS_VALUE}'.`);
      return;
    }

    console.log(`[clean-script] Found ${targets.length} files to delete:`);
    console.table(targets.map((x) => ({ name: x.name, status: x.status })));

    if (DRY_RUN) {
      console.log("[clean-script] DRY_RUN=true, skip delete.");
      return;
    }

    let success = 0;
    const failed = [];

    for (const item of targets) {
      const name = String(item.name);
      const encoded = encodeURIComponent(name);
      const path = `/v0/management/auth-files?name=${encoded}`;
      try {
        await requestDelete(path);
        success += 1;
        console.log(`[OK] ${name}`);
      } catch (err) {
        failed.push({ name, error: String(err && err.message ? err.message : err) });
        console.error(`[FAIL] ${name}`, err);
      }
    }

    console.log(`[clean-script] Done. Success: ${success}, Failed: ${failed.length}`);
    if (failed.length > 0) console.table(failed);
  })().catch((err) => {
    console.error("[clean-script] Fatal error:", err);
  });
})();
