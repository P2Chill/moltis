// ── Model selector ──────────────────────────────────────────

import { sendRpc } from "./helpers.js";
import { t } from "./i18n.js";
import { showModelNotice, updateMcpToggleUI, updateThinkToggleUI } from "./page-chat.js";
import { updateSandboxUI } from "./sandbox.js";
import * as S from "./state.js";
import { modelStore } from "./stores/model-store.js";

function setSessionModel(sessionKey, modelId) {
	sendRpc("sessions.patch", { key: sessionKey, model: modelId });
}

export { setSessionModel };

function updateModelComboLabel(model) {
	if (S.modelComboLabel) S.modelComboLabel.textContent = model.displayName || model.id;
}

export function fetchModels() {
	return modelStore.fetch().then(() => {
		// Dual-write to state.js for backward compat
		S.setModels(modelStore.models.value);
		S.setSelectedModelId(modelStore.selectedModelId.value);
		var model = modelStore.selectedModel.value;
		if (model) updateModelComboLabel(model);

		// If the dropdown is currently open, re-render to reflect updated flags
		// (for example when a model becomes unsupported via a WS event).
		if (S.modelDropdown && !S.modelDropdown.classList.contains("hidden")) {
			var query = S.modelSearchInput ? S.modelSearchInput.value.trim() : "";
			renderModelList(query);
		}
	});
}

export function selectModel(m) {
	modelStore.select(m.id);
	// Dual-write to state.js for backward compat
	S.setSelectedModelId(m.id);
	updateModelComboLabel(m);
	localStorage.setItem("moltis-model", m.id);
	setSessionModel(S.activeSessionKey, m.id);
	closeModelDropdown();
	// Show notice if model doesn't support tools
	showModelNotice(m);
	// Apply per-model overrides (MCP, sandbox) to the active session
	applyModelOverrides(m.id);
}

function applyModelOverrides(modelId) {
	var overrideKey = modelId.split("::").pop();
	sendRpc("tools.model_overrides.get", {}).then((res) => {
		if (!res?.ok) return;
		var overrides = res.payload?.overrides || {};
		var key = Object.keys(overrides).find(function(k) {
			return k.toLowerCase() === overrideKey.toLowerCase();
		});
		var ov = key ? overrides[key] : {};
		var mcpEnabled = ov.mcp_enabled ?? true;
		var sandboxEnabled = ov.sandbox_enabled ?? false;
		// Only patch session when values actually differ to avoid spamming
		// "Sandbox enabled/disabled" system messages on every model switch.
		var patch = {};
		var mcpLabel = S.$("mcpToggleLabel");
		var currentMcpEnabled = mcpLabel ? mcpLabel.textContent === "MCP" : true;
		if (mcpEnabled !== currentMcpEnabled) patch.mcpDisabled = !mcpEnabled;
		if (sandboxEnabled !== S.sessionSandboxEnabled) patch.sandboxEnabled = sandboxEnabled;
		if (Object.keys(patch).length > 0) {
			patch.key = S.activeSessionKey;
			sendRpc("sessions.patch", patch);
		}
		var thinkingEnabled = ov.thinking_enabled ?? false;
		if (thinkingEnabled !== false) patch.thinkingEnabled = thinkingEnabled;
		updateMcpToggleUI(mcpEnabled);
		updateSandboxUI(sandboxEnabled);
		updateThinkToggleUI(thinkingEnabled);
	});
}

export function openModelDropdown() {
	if (!S.modelDropdown) return;
	S.modelDropdown.classList.remove("hidden");
	S.modelSearchInput.value = "";
	S.setModelIdx(-1);
	renderModelList("");
	requestAnimationFrame(() => {
		if (S.modelSearchInput) S.modelSearchInput.focus();
	});
}

export function closeModelDropdown() {
	if (!S.modelDropdown) return;
	S.modelDropdown.classList.add("hidden");
	if (S.modelSearchInput) S.modelSearchInput.value = "";
	S.setModelIdx(-1);
}

function buildModelItem(m, currentId) {
	var el = document.createElement("div");
	el.className = "model-dropdown-item";
	if (m.id === currentId) el.classList.add("selected");
	if (m.unsupported) el.classList.add("model-dropdown-item-unsupported");

	var label = document.createElement("span");
	label.className = "model-item-label";
	label.textContent = m.displayName || m.id;
	el.appendChild(label);

	var meta = document.createElement("span");
	meta.className = "model-item-meta";

	if (m.provider) {
		var prov = document.createElement("span");
		prov.className = "model-item-provider";
		var provName = m.provider.replace(/^custom-/, "");
		var provAliases = { "generativelanguage-googleapis-com": "Google" };
		prov.textContent = provAliases[provName] || provName;
		meta.appendChild(prov);
	}

	if (m.unsupported) {
		var badge = document.createElement("span");
		badge.className = "model-item-unsupported";
		badge.textContent = t("common:labels.unsupported");
		if (m.unsupportedReason) badge.title = m.unsupportedReason;
		meta.appendChild(badge);
	}

	if (meta.childNodes.length > 0) el.appendChild(meta);
	el.addEventListener("click", () => selectModel(m));
	return el;
}

export function renderModelList(query) {
	if (!S.modelDropdownList) return;
	S.modelDropdownList.textContent = "";
	var q = query.toLowerCase();
	var allModels = modelStore.models.value;
	var filtered = allModels.filter((m) => {
		var label = (m.displayName || m.id).toLowerCase();
		var provider = (m.provider || "").toLowerCase();
		return !q || label.indexOf(q) !== -1 || provider.indexOf(q) !== -1 || m.id.toLowerCase().indexOf(q) !== -1;
	});
	if (filtered.length === 0) {
		var empty = document.createElement("div");
		empty.className = "model-dropdown-empty";
		empty.textContent = t("common:labels.noMatchingModels");
		S.modelDropdownList.appendChild(empty);
		return;
	}
	var currentId = modelStore.selectedModelId.value;
	var lastPreferredIdx = filtered.findLastIndex((m) => m.preferred);
	filtered.forEach((m, idx) => {
		S.modelDropdownList.appendChild(buildModelItem(m, currentId));

		if (idx === lastPreferredIdx && lastPreferredIdx < filtered.length - 1) {
			var divider = document.createElement("div");
			divider.className = "model-dropdown-divider";
			S.modelDropdownList.appendChild(divider);
		}
	});
}

function updateModelActive() {
	if (!S.modelDropdownList) return;
	var items = S.modelDropdownList.querySelectorAll(".model-dropdown-item");
	items.forEach((el, i) => {
		el.classList.toggle("kb-active", i === S.modelIdx);
	});
	if (S.modelIdx >= 0 && items[S.modelIdx]) {
		items[S.modelIdx].scrollIntoView({ block: "nearest" });
	}
}

export function bindModelComboEvents() {
	if (!(S.modelComboBtn && S.modelSearchInput && S.modelDropdownList && S.modelCombo)) return;

	S.modelComboBtn.addEventListener("click", () => {
		if (S.modelDropdown.classList.contains("hidden")) {
			openModelDropdown();
		} else {
			closeModelDropdown();
		}
	});

	S.modelSearchInput.addEventListener("input", () => {
		S.setModelIdx(-1);
		renderModelList(S.modelSearchInput.value.trim());
	});

	S.modelSearchInput.addEventListener("keydown", (e) => {
		var items = S.modelDropdownList.querySelectorAll(".model-dropdown-item");
		if (e.key === "ArrowDown") {
			e.preventDefault();
			S.setModelIdx(Math.min(S.modelIdx + 1, items.length - 1));
			updateModelActive();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			S.setModelIdx(Math.max(S.modelIdx - 1, 0));
			updateModelActive();
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (S.modelIdx >= 0 && items[S.modelIdx]) {
				items[S.modelIdx].click();
			} else if (items.length === 1) {
				items[0].click();
			}
		} else if (e.key === "Escape") {
			closeModelDropdown();
			S.modelComboBtn.focus();
		}
	});
}

document.addEventListener("click", (e) => {
	if (S.modelCombo && !S.modelCombo.contains(e.target)) {
		closeModelDropdown();
	}
});

window.addEventListener("moltis:locale-changed", () => {
	if (S.modelDropdown && !S.modelDropdown.classList.contains("hidden")) {
		var query = S.modelSearchInput ? S.modelSearchInput.value.trim() : "";
		renderModelList(query);
	}
});
