/*
Run this in browser DevTools console on http://localhost:8317
No token input is needed when your current page already has auth session.
*/

(() => {
  const BASE_URL = window.location.origin;
  const DRY_RUN = false;
  const SCAN_CONCURRENCY = 8;
  const REQUEST_TIMEOUT_MS = 30000;
  const SHOW_PER_FILE_RESULT = false;
  const API_CALL_URL = "/v0/management/api-call";
  const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
  const CODEX_USER_AGENT = "codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal";

  const getObjectPropertyValue = (obj, names) => {
    if (!obj) return null;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(obj, name)) {
        return obj[name];
      }
    }
    return null;
  };

  const normalizeStringValue = (value) => {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
  };

  const normalizeAuthIndex = (value) => {
    if (value == null) return null;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return normalizeStringValue(value);
  };

  const convertFromBase64UrlPayload = (value) => {
    if (!value || !String(value).trim()) return null;
    try {
      let normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
      while (normalized.length % 4 !== 0) normalized += "=";
      const decoded = atob(normalized);
      const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
      const jsonText = new TextDecoder().decode(bytes);
      return JSON.parse(jsonText);
    } catch {
      return null;
    }
  };

  const parseIdTokenPayload = (value) => {
    if (value == null) return null;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Continue to JWT payload parsing.
    }
    const segments = trimmed.split(".");
    if (segments.length < 2) return null;
    return convertFromBase64UrlPayload(segments[1]);
  };

  const resolveChatgptAccountId = (file) => {
    if (!file) return null;
    const metadata = getObjectPropertyValue(file, ["metadata"]);
    const attributes = getObjectPropertyValue(file, ["attributes"]);

    const directCandidates = [
      getObjectPropertyValue(file, ["chatgpt_account_id", "chatgptAccountId"]),
      getObjectPropertyValue(metadata, ["chatgpt_account_id", "chatgptAccountId"]),
      getObjectPropertyValue(attributes, ["chatgpt_account_id", "chatgptAccountId"])
    ];
    for (const candidate of directCandidates) {
      const value = normalizeStringValue(candidate);
      if (value) return value;
    }

    const idTokenCandidates = [
      getObjectPropertyValue(file, ["id_token"]),
      getObjectPropertyValue(metadata, ["id_token"]),
      getObjectPropertyValue(attributes, ["id_token"])
    ];

    for (const idToken of idTokenCandidates) {
      const payload = parseIdTokenPayload(idToken);
      if (!payload) continue;
      const accountId = normalizeStringValue(
        getObjectPropertyValue(payload, ["chatgpt_account_id", "chatgptAccountId"])
      );
      if (accountId) return accountId;
    }

    return null;
  };

  const normalizeFiles = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.files)) return payload.files;
    throw new Error("No files array found in response.");
  };

  const requestJson = async (method, path, body = undefined, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const hasAbort = typeof AbortController !== "undefined";
    const controller = hasAbort ? new AbortController() : null;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        credentials: "include",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`${method} ${path} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
    }

    if (res.status === 204) return null;
    return res.json();
  };

  const requestDelete = async (path, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const hasAbort = typeof AbortController !== "undefined";
    const controller = hasAbort ? new AbortController() : null;
    const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method: "DELETE",
        credentials: "include",
        signal: controller ? controller.signal : undefined
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`DELETE ${path} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DELETE ${path} failed: ${res.status} ${res.statusText} ${text}`.trim());
    }
  };

  const mapWithConcurrency = async (items, concurrency, mapper) => {
    const safeConcurrency = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
    if (items.length === 0) return [];

    const results = new Array(items.length);
    let index = 0;

    const worker = async () => {
      while (true) {
        const current = index;
        index += 1;
        if (current >= items.length) break;
        results[current] = await mapper(items[current], current);
      }
    };

    const workers = Array.from({ length: Math.min(safeConcurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  };

  (async () => {
    console.log(`[clean-script] Listing auth files from ${BASE_URL} ...`);
    const payload = await requestJson("GET", "/v0/management/auth-files");
    const files = normalizeFiles(payload);

    if (files.length === 0) {
      console.log("[clean-script] No auth files found.");
      return;
    }

    console.log(`[clean-script] Found ${files.length} auth files. Verifying validity via ${API_CALL_URL} ...`);

    const checkResults = [];
    const apiCheckCandidates = [];

    for (const file of files) {
      if (!file) continue;
      const name = normalizeStringValue(getObjectPropertyValue(file, ["name"]));
      if (!name) continue;

      const rawAuthIndex = getObjectPropertyValue(file, ["auth_index", "authIndex"]);
      const authIndex = normalizeAuthIndex(rawAuthIndex);
      const accountId = resolveChatgptAccountId(file);

      if (!authIndex) {
        checkResults.push({
          name,
          authIndex: null,
          statusCode: null,
          valid: false,
          reason: "missing authIndex"
        });
        console.warn(`[INVALID] ${name} -> missing authIndex`);
        continue;
      }

      if (!accountId) {
        checkResults.push({
          name,
          authIndex,
          statusCode: null,
          valid: false,
          reason: "missing Chatgpt-Account-Id"
        });
        console.warn(`[INVALID] ${name} -> missing Chatgpt-Account-Id`);
        continue;
      }

      apiCheckCandidates.push({ name, authIndex, accountId });
    }

    if (apiCheckCandidates.length > 0) {
      console.log(
        `[clean-script] Prepared ${apiCheckCandidates.length} files for API validation. SCAN_CONCURRENCY=${SCAN_CONCURRENCY}`
      );

      const validatedResults = await mapWithConcurrency(apiCheckCandidates, SCAN_CONCURRENCY, async (item) => {
        const { name, authIndex, accountId } = item;

        const apiPayload = {
          authIndex,
          method: "GET",
          url: USAGE_URL,
          header: {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "User-Agent": CODEX_USER_AGENT,
            "Chatgpt-Account-Id": accountId
          }
        };

        try {
          const apiResp = await requestJson("POST", API_CALL_URL, apiPayload);
          const statusRaw = getObjectPropertyValue(apiResp, ["status_code", "statusCode"]);
          const statusCode = Number.parseInt(String(statusRaw ?? ""), 10);
          const finalStatusCode = Number.isFinite(statusCode) ? statusCode : 0;
          const isValid = finalStatusCode === 200;
          const reason = isValid ? "status_code=200" : `status_code=${finalStatusCode}`;

          return {
            name,
            authIndex,
            statusCode: finalStatusCode,
            valid: isValid,
            reason
          };
        } catch (err) {
          const message = String(err && err.message ? err.message : err);
          return {
            name,
            authIndex,
            statusCode: null,
            valid: false,
            reason: message
          };
        }
      });

      checkResults.push(...validatedResults);
    }

    if (SHOW_PER_FILE_RESULT) {
      for (const result of checkResults) {
        if (result.valid) {
          console.log(`[VALID] ${result.name} -> ${result.reason}`);
        } else {
          console.warn(`[INVALID] ${result.name} -> ${result.reason}`);
        }
      }
    }

    const targets = checkResults.filter((x) => x && x.valid === false);
    const validCount = checkResults.filter((x) => x && x.valid === true).length;

    console.log("");
    console.log(`[clean-script] Validation done. Valid: ${validCount}, Invalid: ${targets.length}`);

    if (targets.length === 0) {
      console.log("[clean-script] No invalid auth files to delete.");
      return;
    }

    console.log("[clean-script] Invalid files to delete:");
    console.table(targets.map((x) => ({ name: x.name, reason: x.reason })));

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
