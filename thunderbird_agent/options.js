const fields = ["ollama_url", "ollama_model", "litellm_url", "litellm_model", "litellm_key"];

function send(action, extra = {}) {
  return browser.runtime.sendMessage({ action, ...extra });
}

async function load() {
  const resp = await send("getSettings");
  if (!resp.ok) return;
  for (const key of fields) {
    document.getElementById(key).value = resp.data[key] ?? "";
  }
  const totalHistory = (resp.data.history || []).length + (resp.data.newEmailHistory || []).length;
  document.getElementById("history-count").textContent = totalHistory;

  document.getElementById("rag-enabled").checked = !!resp.data.ragEnabled;
  document.getElementById("rag-embed-model").value = resp.data.ragEmbedModel || "nomic-embed-text";
  document.getElementById("rag-pull-interval").value = resp.data.ragPullIntervalMinutes || 60;
  await loadRagAccounts(resp.data.ragAccountId || "");
  await loadRagFolders(resp.data.ragAccountId || "", resp.data.ragFolderIds || []);
  await refreshRagStatus();
}

async function loadRagAccounts(selectedId) {
  const select = document.getElementById("rag-account");
  const accountsResp = await send("ragListAccounts");
  if (accountsResp.ok) {
    for (const account of accountsResp.data) {
      const option = document.createElement("option");
      option.value = account.id;
      option.textContent = account.name;
      select.appendChild(option);
    }
  }
  select.value = selectedId;
}

// Folder-level scoping only makes sense once a single account is picked (matching the "every
// folder of the selected account" wording above the account dropdown) -- "All accounts" hides it.
async function loadRagFolders(accountId, selectedIds) {
  const fieldEl = document.getElementById("rag-folders-field");
  const listEl = document.getElementById("rag-folders-list");
  listEl.innerHTML = "";

  if (!accountId) {
    fieldEl.hidden = true;
    return;
  }
  fieldEl.hidden = false;

  const foldersResp = await send("ragListFolders", { accountId });
  if (!foldersResp.ok || foldersResp.data.length === 0) {
    listEl.innerHTML = `<div class="muted">No folders found for this account.</div>`;
    return;
  }
  for (const folder of foldersResp.data) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = folder.id;
    checkbox.checked = selectedIds.includes(folder.id);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(folder.path));
    listEl.appendChild(label);
  }
}

function getSelectedFolderIds() {
  const listEl = document.getElementById("rag-folders-list");
  return Array.from(listEl.querySelectorAll("input[type=checkbox]:checked")).map((cb) => cb.value);
}

async function save() {
  const settings = {};
  for (const key of fields) {
    settings[key] = document.getElementById(key).value.trim();
  }
  settings.ragEnabled = document.getElementById("rag-enabled").checked;
  settings.ragAccountId = document.getElementById("rag-account").value;
  settings.ragFolderIds = settings.ragAccountId ? getSelectedFolderIds() : [];
  settings.ragEmbedModel = document.getElementById("rag-embed-model").value.trim() || "nomic-embed-text";
  settings.ragPullIntervalMinutes = parseInt(document.getElementById("rag-pull-interval").value, 10) || 60;
  await send("saveSettings", { settings });

  const statusEl = document.getElementById("save-status");
  statusEl.hidden = false;
  statusEl.textContent = "Saved.";
  setTimeout(() => { statusEl.hidden = true; }, 2000);

  await refreshRagStatus();
}

async function clearHistory() {
  await send("saveSettings", { settings: { history: [], newEmailHistory: [] } });
  document.getElementById("history-count").textContent = "0";
}

// Model fetching state -- one AbortController per backend, so we can stop an in-flight listModels call.
let fetchAbortControllers = {}; // { local: AbortController, remote: AbortController }

// --------------------------------------------------------------------------
// Model fetching -- listModels via background.js, populate dropdown, select.
// --------------------------------------------------------------------------

function getBackendFromSelect(selectId) {
  // Determine which backend a dropdown belongs to by looking at the parent section.
  const select = document.getElementById(selectId);
  if (!select) return null;
  const section = select.closest("section");
  if (!section) return null;
  const heading = section.querySelector("h2");
  if (!heading) return null;
  return heading.textContent.includes("LiteLLM") ? "remote" : "local";
}

async function fetchModels(backend) {
  const backendLabel = backend === "local" ? "Ollama" : "LiteLLM proxy";
  const selectId = backend === "local" ? "ollama-model-select" : "litellm-model-select";
  const statusId = backend === "local" ? "ollama-models-status" : "litellm-models-status";
  const selectFieldId = backend === "local" ? "ollama-model-select-field" : "litellm-model-select-field";
  const fetchBtnId = backend === "local" ? "fetch-ollama-models" : "fetch-litellm-models";
  const stopBtnId = backend === "local" ? "stop-ollama-fetch" : "stop-litellm-fetch";
  const modelFieldId = backend === "local" ? "ollama_model" : "litellm_model";

  const select = document.getElementById(selectId);
  const statusEl = document.getElementById(statusId);
  const selectField = document.getElementById(selectFieldId);
  const fetchBtn = document.getElementById(fetchBtnId);
  const stopBtn = document.getElementById(stopBtnId);

  if (!select || !statusEl || !selectField || !fetchBtn || !stopBtn) return;

  // Abort any in-flight request.
  if (fetchAbortControllers[backend]) {
    fetchAbortControllers[backend].abort();
  }

  fetchBtn.disabled = true;
  stopBtn.hidden = false;
  statusEl.hidden = false;
  statusEl.textContent = `Fetching models from ${backendLabel}...`;

  fetchAbortControllers[backend] = new AbortController();

  try {
    // Gather current settings values to pass to listModels.
    const settings = {};
    for (const key of fields) {
      settings[key] = document.getElementById(key).value.trim();
    }
    settings.ragEnabled = document.getElementById("rag-enabled").checked;
    settings.ragAccountId = document.getElementById("rag-account").value;
    settings.ragEmbedModel = document.getElementById("rag-embed-model").value.trim() || "nomic-embed-text";
    settings.ragPullIntervalMinutes = parseInt(document.getElementById("rag-pull-interval").value, 10) || 60;

    const resp = await send("listModels", { settings, backend });

    if (!resp || !resp.ok) {
      throw new Error(resp?.error || `No response from ${backendLabel} -- check the URL and try again.`);
    }

    const models = resp.data;

    statusEl.hidden = true;
    selectField.hidden = false;

    // Clear existing options (keep the placeholder).
    while (select.options.length > 1) {
      select.remove(1);
    }

    if (models.length === 0) {
      statusEl.hidden = false;
      statusEl.textContent = `No models found on ${backendLabel}.`;
      selectField.hidden = true;
      fetchBtn.disabled = false;
      stopBtn.hidden = true;
      return;
    }

    // Sort alphabetically.
    const sorted = models.slice().sort((a, b) => (a.id || "").localeCompare(b.id || ""));

    for (const model of sorted) {
      const opt = document.createElement("option");
      opt.value = model.id;
      const label = model.owned_by
        ? `${model.id} (${model.owned_by})`
        : model.id;
      opt.textContent = label;
      select.appendChild(opt);
    }

    // Highlight current model selection.
    const currentModel = document.getElementById(modelFieldId).value.trim();
    if (currentModel) {
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === currentModel) {
          select.selectedIndex = i;
          break;
        }
      }
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.hidden = false;
    selectField.hidden = true;
  } finally {
    fetchBtn.disabled = false;
    stopBtn.hidden = true;
    delete fetchAbortControllers[backend];
  }
}

function stopFetch(backend) {
  const abortController = fetchAbortControllers[backend];
  if (abortController) {
    abortController.abort();
  }
  // The finally block will clean up the UI state.
}

// Wire up model dropdown selection: when user picks a model, update the model name input.
function onModelSelectChange(backend) {
  const selectId = backend === "local" ? "ollama-model-select" : "litellm-model-select";
  const modelFieldId = backend === "local" ? "ollama_model" : "litellm_model";
  const select = document.getElementById(selectId);
  const modelInput = document.getElementById(modelFieldId);

  if (!select || !modelInput) return;

  select.addEventListener("change", () => {
    if (select.value) {
      modelInput.value = select.value;
    }
  });
}

// --------------------------------------------------------------------------
// RAG status polling (existing code).
// --------------------------------------------------------------------------

let ragPollTimer = null;

function renderRagStatus(status) {
  const el = document.getElementById("rag-status");
  const pullBtn = document.getElementById("rag-pull-now");
  if (!status) {
    el.textContent = "Status unavailable.";
    return;
  }
  const parts = [`${status.indexedMessageCount} message(s) indexed`, `${status.chunkCount} chunk(s)`];
  if (status.running) {
    parts.push(`indexing in progress... ${status.processedMessages}/${status.totalMessages || "?"}`
      + (status.currentFolder ? ` (${status.currentFolder})` : ""));
  } else if (status.lastPullAt) {
    parts.push(`last pull: ${new Date(status.lastPullAt).toLocaleString()}`);
  } else {
    parts.push("never pulled");
  }
  if (status.lastError) parts.push(`last error: ${status.lastError}`);
  el.textContent = parts.join(" -- ");
  pullBtn.disabled = status.running;
}

async function refreshRagStatus() {
  const resp = await send("ragGetStatus");
  if (!resp.ok) {
    renderRagStatus(null);
    return;
  }
  renderRagStatus(resp.data);

  if (resp.data.running && !ragPollTimer) {
    ragPollTimer = setInterval(async () => {
      const poll = await send("ragGetStatus");
      if (poll.ok) renderRagStatus(poll.data);
      if (!poll.ok || !poll.data.running) {
        clearInterval(ragPollTimer);
        ragPollTimer = null;
      }
    }, 1500);
  }
}

async function pullNow() {
  await send("ragPullNow");
  await refreshRagStatus();
}

async function clearIndex() {
  await send("ragClearIndex");
  await refreshRagStatus();
}

document.getElementById("rag-account").addEventListener("change", (e) => {
  loadRagFolders(e.target.value, []);
});

document.getElementById("save").addEventListener("click", save);
document.getElementById("clear-history").addEventListener("click", clearHistory);
document.getElementById("rag-pull-now").addEventListener("click", pullNow);
document.getElementById("rag-clear-index").addEventListener("click", clearIndex);

// Model fetch event listeners -- Ollama (local)
document.getElementById("fetch-ollama-models").addEventListener("click", () => fetchModels("local"));
document.getElementById("stop-ollama-fetch").addEventListener("click", () => stopFetch("local"));

// Model fetch event listeners -- LiteLLM (remote)
document.getElementById("fetch-litellm-models").addEventListener("click", () => fetchModels("remote"));
document.getElementById("stop-litellm-fetch").addEventListener("click", () => stopFetch("remote"));

// Wire up model dropdown selection -- changing the dropdown updates the model name input
onModelSelectChange("local");
onModelSelectChange("remote");

load();
