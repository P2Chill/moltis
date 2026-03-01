// ── Voice input module ───────────────────────────────────────
// Handles microphone recording and speech-to-text transcription.
// Supports three input modes:
//   1. Toggle (default): click mic to start, click again to stop & send
//   2. Push-to-talk (PTT): hold a hotkey to record, release to send
//   3. VAD (continuous): click waveform button to enter hands-free mode;
//      auto-detects speech via energy-based VAD, auto-sends on silence,
//      auto-re-listens after TTS playback finishes.

import { chatAddMsg } from "./chat-ui.js";
import * as gon from "./gon.js";
import { renderAudioPlayer, renderMarkdown, sendRpc, warmAudioPlayback } from "./helpers.js";
import { t } from "./i18n.js";
import { bumpSessionCount, seedSessionPreviewFromUserText, setSessionReplying } from "./sessions.js";
import * as S from "./state.js";
import { sessionStore } from "./stores/session-store.js";

// ── Shared state ─────────────────────────────────────────────
var micBtn = null;
var vadBtn = null;
var mediaRecorder = null;
var audioChunks = [];
var sttConfigured = false;
var isRecording = false;
var isStarting = false;
var transcribingEl = null;

// ── PTT state ────────────────────────────────────────────────
var pttKey = localStorage.getItem("moltis_ptt_key") || "F13";
var pttActive = false; // true while PTT key is held

// ── Tab coordination (prevent dual-tab recording) ────────────
// Only one tab should handle PTT/toggle at a time. When a tab starts
// recording, it broadcasts a claim. Other tabs back off.
var voiceLockChannel = typeof BroadcastChannel !== "undefined"
	? new BroadcastChannel("moltis_voice_lock") : null;
var voiceLockedByOtherTab = false;
if (voiceLockChannel) {
	voiceLockChannel.onmessage = (e) => {
		if (e.data?.type === "voice_lock") {
			voiceLockedByOtherTab = true;
			console.debug("[voice] another tab claimed voice lock");
		} else if (e.data?.type === "voice_unlock") {
			voiceLockedByOtherTab = false;
			console.debug("[voice] another tab released voice lock");
		}
	};
}
function claimVoiceLock() {
	voiceLockedByOtherTab = false;
	if (voiceLockChannel) voiceLockChannel.postMessage({ type: "voice_lock" });
}
function releaseVoiceLock() {
	if (voiceLockChannel) voiceLockChannel.postMessage({ type: "voice_unlock" });
}

// ── VAD state ────────────────────────────────────────────────
var vadActive = false;
var vadStream = null;
var vadAudioCtx = null;
var vadAnalyser = null;
var vadDataArray = null;
var vadRafId = null;
var vadSpeechDetected = false;
var vadSilenceStart = 0;
var vadMutedForTts = false;
var VAD_SPEECH_THRESHOLD = 0.045; // RMS threshold — speech above this
var VAD_SILENCE_DURATION = 2500; // ms of silence before auto-send
var VAD_DEBOUNCE_SPEECH = 250; // ms of speech before we consider it speech
var vadSpeechStart = 0;
var vadRecordingStart = 0;
var vadMediaRecorder = null; // separate recorder for VAD continuous mode

/** Check if voice feature is enabled. */
function isVoiceEnabled() {
	return gon.get("voice_enabled") === true;
}

/** Check if STT is available and enable/disable buttons. */
async function checkSttStatus() {
	if (!isVoiceEnabled()) {
		sttConfigured = false;
		updateMicButton();
		updateVadButton();
		return;
	}
	var res = await sendRpc("stt.status", {});
	if (res?.ok && res.payload) {
		sttConfigured = res.payload.configured === true;
	} else {
		sttConfigured = false;
	}
	updateMicButton();
	updateVadButton();
}

// ── Mic button (toggle mode) ─────────────────────────────────

function updateMicButton() {
	if (!micBtn) return;
	micBtn.style.display = sttConfigured && isVoiceEnabled() ? "" : "none";
	micBtn.disabled = !S.connected;
	micBtn.title = isStarting
		? "Starting microphone..."
		: isRecording
			? "Click to stop and send"
			: "Click to start recording";
}

// ── VAD button ───────────────────────────────────────────────

function updateVadButton() {
	if (!vadBtn) return;
	vadBtn.style.display = sttConfigured && isVoiceEnabled() ? "" : "none";
	vadBtn.disabled = !S.connected;
	vadBtn.title = vadActive ? "Click to stop conversation mode" : "Conversation mode (VAD)";
}

// ── Audio helpers ────────────────────────────────────────────

function stopAllAudio() {
	for (var audio of document.querySelectorAll("audio")) {
		if (!audio.paused) {
			audio.pause();
			console.debug("[voice] paused playing audio");
		}
	}
}

function getRMS(analyser, dataArray) {
	analyser.getByteTimeDomainData(dataArray);
	var sum = 0;
	for (var sample of dataArray) {
		var val = (sample - 128) / 128;
		sum += val * val;
	}
	return Math.sqrt(sum / dataArray.length);
}

// ── Recording (shared by toggle + PTT + VAD) ─────────────────

async function startRecording(opts) {
	if (isRecording || isStarting || !sttConfigured) return;

	var fromVad = opts?.fromVad === true;
	var stream = opts?.stream || null;

	if (!fromVad) stopAllAudio();

	isStarting = true;
	if (micBtn && !fromVad) {
		micBtn.classList.add("starting");
		micBtn.setAttribute("aria-busy", "true");
		micBtn.title = "Starting microphone...";
	}

	try {
		if (!stream) {
			stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		}
		audioChunks = [];
		var recordingUiShown = false;

		function showRecordingUi() {
			if (recordingUiShown) return;
			recordingUiShown = true;
			isStarting = false;
			if (fromVad) {
				if (vadBtn) vadBtn.classList.add("vad-speech");
			} else if (micBtn) {
				micBtn.classList.remove("starting");
				micBtn.removeAttribute("aria-busy");
				micBtn.classList.add("recording");
				micBtn.setAttribute("aria-pressed", "true");
				micBtn.title = "Click to stop and send";
			}
		}

		var mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
		mediaRecorder = new MediaRecorder(stream, { mimeType });

		mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) {
				audioChunks.push(e.data);
				showRecordingUi();
			}
		};

		mediaRecorder.onstart = () => {
			isRecording = true;
		};

		var audioTrack = stream.getAudioTracks()[0];
		if (audioTrack && !audioTrack.muted) {
			setTimeout(showRecordingUi, 150);
		} else if (audioTrack) {
			audioTrack.addEventListener("unmute", showRecordingUi, { once: true });
		}

		mediaRecorder.onstop = async () => {
			// Only stop tracks if NOT in VAD mode (VAD keeps the stream open)
			if (!fromVad) {
				for (var track of stream.getTracks()) {
					track.stop();
				}
			}
			if (fromVad && vadBtn) {
				vadBtn.classList.remove("vad-speech");
			}
			await transcribeAudio();
		};

		mediaRecorder.start(250);
	} catch (err) {
		isStarting = false;
		isRecording = false;
		if (micBtn && !fromVad) {
			micBtn.classList.remove("starting");
			micBtn.removeAttribute("aria-busy");
			micBtn.setAttribute("aria-pressed", "false");
			micBtn.title = "Click to start recording";
		}
		console.error("Failed to start recording:", err);
		if (err.name === "NotAllowedError") {
			alert("Microphone permission denied. Please allow microphone access in your browser settings.");
		} else if (err.name === "NotFoundError") {
			alert("No microphone found. Please connect a microphone and try again.");
		}
	}
}

function stopRecording() {
	if (!(isRecording && mediaRecorder)) return;

	isStarting = false;
	isRecording = false;
	if (micBtn) {
		micBtn.classList.remove("starting");
		micBtn.removeAttribute("aria-busy");
		micBtn.classList.remove("recording");
		micBtn.setAttribute("aria-pressed", "false");
		micBtn.classList.add("transcribing");
		micBtn.title = "Transcribing...";
	}
	mediaRecorder.stop();
}

function cancelRecording() {
	if (!(isRecording && mediaRecorder)) return;
	console.debug("[voice] recording cancelled via Escape");
	audioChunks = [];
	isStarting = false;
	isRecording = false;
	if (micBtn) {
		micBtn.classList.remove("starting", "recording");
		micBtn.removeAttribute("aria-busy");
		micBtn.setAttribute("aria-pressed", "false");
		micBtn.title = "Click to start recording";
	}
	if (vadBtn) vadBtn.classList.remove("vad-speech");
	mediaRecorder.stop();
}

// ── Transcription UI helpers ─────────────────────────────────

function createTranscribingIndicator(message, isError) {
	var el = document.createElement("div");
	el.className = "msg voice-transcribing";
	var spinner = document.createElement("span");
	spinner.className = "voice-transcribing-spinner";
	var text = document.createElement("span");
	text.className = "voice-transcribing-text";
	if (isError) text.classList.add("text-[var(--error)]");
	text.textContent = message;
	if (!isError) el.appendChild(spinner);
	el.appendChild(text);
	return el;
}

function updateTranscribingMessage(message, isError) {
	if (!transcribingEl) return;
	transcribingEl.textContent = "";
	var text = document.createElement("span");
	text.className = "voice-transcribing-text";
	text.classList.add(isError ? "text-[var(--error)]" : "text-[var(--muted)]");
	text.textContent = message;
	transcribingEl.appendChild(text);
}

function showTemporaryMessage(message, isError, delayMs) {
	updateTranscribingMessage(message, isError);
	setTimeout(() => {
		if (transcribingEl) {
			transcribingEl.remove();
			transcribingEl = null;
		}
	}, delayMs);
}

function cleanupTranscribingState() {
	isStarting = false;
	if (micBtn) {
		micBtn.classList.remove("starting");
		micBtn.removeAttribute("aria-busy");
		micBtn.classList.remove("transcribing");
		micBtn.title = "Click to start recording";
	}
	if (transcribingEl) {
		transcribingEl.remove();
		transcribingEl = null;
	}
}

// ── Send transcribed message ─────────────────────────────────

function sendTranscribedMessage(text, audioFilename) {
	window._moltisVoiceSource = true;
	warmAudioPlayback();

	if (audioFilename) {
		var userEl = chatAddMsg("user", "", true);
		if (userEl) {
			var audioSrc = `/api/sessions/${encodeURIComponent(S.activeSessionKey)}/media/${encodeURIComponent(audioFilename)}`;
			renderAudioPlayer(userEl, audioSrc);
			if (text) {
				var textWrap = document.createElement("div");
				textWrap.className = "mt-2";
				textWrap.innerHTML = renderMarkdown(text); // eslint-disable-line no-unsanitized/property
				userEl.appendChild(textWrap);
			}
		}
	} else {
		chatAddMsg("user", renderMarkdown(text), true);
	}

	var chatParams = { text: text, _input_medium: "voice" };
	if (audioFilename) chatParams._audio_filename = audioFilename;
	var selectedModel = S.selectedModelId;
	if (selectedModel) chatParams.model = selectedModel;
	bumpSessionCount(S.activeSessionKey, 1);
	seedSessionPreviewFromUserText(S.activeSessionKey, text);
	setSessionReplying(S.activeSessionKey, true);
	sendRpc("chat.send", chatParams).then((sendRes) => {
		if (sendRes && !sendRes.ok && sendRes.error) {
			chatAddMsg("error", sendRes.error.message || "Request failed");
		}
	});
}

// ── Transcription ────────────────────────────────────────────

async function transcribeAudio() {
	if (audioChunks.length === 0) {
		cleanupTranscribingState();
		return;
	}

	if (S.chatMsgBox) {
		transcribingEl = createTranscribingIndicator("Transcribing voice...", false);
		S.chatMsgBox.appendChild(transcribingEl);
		S.chatMsgBox.scrollTop = S.chatMsgBox.scrollHeight;
	}

	try {
		var blob = new Blob(audioChunks, { type: "audio/webm" });
		audioChunks = [];

		var resp = await fetch(`/api/sessions/${encodeURIComponent(S.activeSessionKey)}/upload?transcribe=true`, {
			method: "POST",
			headers: { "Content-Type": blob.type || "audio/webm" },
			body: blob,
		});
		var res = await resp.json();

		if (micBtn) {
			micBtn.classList.remove("transcribing");
			micBtn.title = "Click to start recording";
		}

		if (res.ok && res.transcription?.text) {
			var text = res.transcription.text.trim();
			var audioFilename = typeof res.filename === "string" ? res.filename.trim() : "";
			if (text) {
				cleanupTranscribingState();
				sendTranscribedMessage(text, audioFilename || null);
			} else {
				showTemporaryMessage("No speech detected", false, 2000);
			}
		} else if (res.transcriptionError) {
			console.error("Transcription failed:", res.transcriptionError);
			showTemporaryMessage(`Transcription failed: ${res.transcriptionError}`, true, 4000);
		} else if (!res.ok) {
			console.error("Upload failed:", res.error);
			showTemporaryMessage(`Upload failed: ${res.error || "Unknown error"}`, true, 4000);
		}
	} catch (err) {
		console.error("Transcription error:", err);
		if (micBtn) {
			micBtn.classList.remove("transcribing");
			micBtn.title = "Click to start recording";
		}
		showTemporaryMessage("Transcription error", true, 4000);
	}
}

// ── Toggle mode (mic button click) ───────────────────────────

function onMicClick(e) {
	e.preventDefault();
	if (vadActive) return; // don't interfere with VAD mode
	if (isRecording) {
		releaseVoiceLock();
		stopRecording();
	} else {
		if (voiceLockedByOtherTab) return; // another tab is recording
		claimVoiceLock();
		startRecording();
	}
}

// ── PTT (push-to-talk via hotkey) ────────────────────────────

function onPttKeyDown(e) {
	if (e.key !== pttKey) return;
	if (vadActive || pttActive || isRecording) return;
	// Allow function keys (F1-F24) even in inputs — dedicated hardware keys.
	// Block regular character keys when typing in an input/textarea.
	var isFunctionKey = /^F[0-9]{1,2}$/.test(e.key);
	if (!isFunctionKey) {
		var tag = document.activeElement?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
	}

	e.preventDefault();
	if (voiceLockedByOtherTab) return; // another tab is recording
	pttActive = true;
	claimVoiceLock();
	console.debug("[voice] PTT start:", pttKey);
	stopAllAudio();
	startRecording();
}

function onPttKeyUp(e) {
	if (e.key !== pttKey) return;
	if (!pttActive) return;

	e.preventDefault();
	pttActive = false;
	releaseVoiceLock();
	console.debug("[voice] PTT release — sending");
	stopRecording();
}

// ── VAD (voice activity detection) ───────────────────────────

async function startVad() {
	if (vadActive) return;

	console.debug("[voice] VAD starting");
	try {
		vadStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
		});
	} catch (err) {
		console.error("[voice] VAD mic access failed:", err);
		if (err.name === "NotAllowedError") {
			alert("Microphone permission denied.");
		}
		return;
	}

	vadActive = true;
	vadSpeechDetected = false;
	vadSilenceStart = 0;
	vadSpeechStart = 0;
	vadMutedForTts = false;
	claimVoiceLock();

	if (vadBtn) {
		vadBtn.classList.add("vad-active");
		vadBtn.title = "Click to stop conversation mode";
	}

	// Set up audio analysis
	vadAudioCtx = new AudioContext();
	var source = vadAudioCtx.createMediaStreamSource(vadStream);
	vadAnalyser = vadAudioCtx.createAnalyser();
	vadAnalyser.fftSize = 512;
	vadAnalyser.smoothingTimeConstant = 0.3;
	source.connect(vadAnalyser);
	vadDataArray = new Uint8Array(vadAnalyser.fftSize);

	// Start continuous recording immediately — captures full audio including
	// lead-in before speech detection, so Whisper gets complete utterances.
	vadStartContinuousRecorder();

	// Start monitoring loop
	vadMonitorLoop();

	// Watch for TTS audio playback to mute/unmute
	document.addEventListener("play", onTtsPlay, true);
	document.addEventListener("ended", onTtsEnded, true);
	document.addEventListener("pause", onTtsPause, true);
}

/** Start (or restart) the continuous MediaRecorder for VAD mode.
 *  Runs the entire time we are listening — speech/silence detection
 *  only decides when to STOP and SEND, not when to start recording. */
function vadStartContinuousRecorder() {
	if (!vadActive || !vadStream) return;
	audioChunks = [];
	var mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
		? "audio/webm;codecs=opus" : "audio/webm";
	vadMediaRecorder = new MediaRecorder(vadStream, { mimeType });
	vadMediaRecorder.ondataavailable = (e) => {
		if (e.data.size > 0) audioChunks.push(e.data);
	};
	vadMediaRecorder.onstop = async () => {
		if (vadBtn) vadBtn.classList.remove("vad-speech");
		// Only transcribe if we actually detected speech in this cycle
		if (audioChunks.length > 0 && vadSpeechDetected) {
			vadSpeechDetected = false;
			await transcribeAudio();
		} else {
			audioChunks = [];
			vadSpeechDetected = false;
		}
		// Restart recorder for next listening cycle (if still active and not muted)
		if (vadActive && !vadMutedForTts) {
			var activeSession = sessionStore.getByKey(S.activeSessionKey);
			if (!(activeSession?.replying.value)) {
				vadStartContinuousRecorder();
			}
		}
	};
	vadMediaRecorder.start(250); // collect data every 250ms
	console.debug("[voice] VAD continuous recorder started");
}

function stopVad() {
	if (!vadActive) return;
	console.debug("[voice] VAD stopping");

	vadActive = false;
	vadSpeechDetected = false;

	// Stop VAD continuous recorder
	if (vadMediaRecorder && vadMediaRecorder.state !== "inactive") {
		audioChunks = []; // discard — we're shutting down, not sending
		vadMediaRecorder.stop();
	}
	vadMediaRecorder = null;

	// Cancel any ongoing toggle/PTT recording too
	if (isRecording && mediaRecorder) {
		audioChunks = [];
		isRecording = false;
		mediaRecorder.stop();
	}

	// Stop monitoring
	if (vadRafId) {
		cancelAnimationFrame(vadRafId);
		vadRafId = null;
	}

	// Close audio context
	if (vadAudioCtx) {
		vadAudioCtx.close().catch(() => {});
		vadAudioCtx = null;
		vadAnalyser = null;
		vadDataArray = null;
	}

	// Release mic
	if (vadStream) {
		for (var track of vadStream.getTracks()) track.stop();
		vadStream = null;
	}

	// Clean up UI
	if (vadBtn) {
		vadBtn.classList.remove("vad-active", "vad-speech", "vad-listening");
		vadBtn.title = "Conversation mode (VAD)";
	}

	releaseVoiceLock();

	document.removeEventListener("play", onTtsPlay, true);
	document.removeEventListener("ended", onTtsEnded, true);
	document.removeEventListener("pause", onTtsPause, true);
}

function vadMonitorLoop() {
	if (!vadActive) return;

	// Skip monitoring while TTS is playing or while we are transcribing
	if (vadMutedForTts || micBtn?.classList.contains("transcribing")) {
		vadRafId = requestAnimationFrame(vadMonitorLoop);
		return;
	}

	// Also skip if the session is still replying (waiting for AI response)
	var activeSession = sessionStore.getByKey(S.activeSessionKey);
	if (activeSession?.replying.value) {
		vadRafId = requestAnimationFrame(vadMonitorLoop);
		return;
	}

	// Show listening state when recorder is running
	if (vadMediaRecorder && vadMediaRecorder.state === "recording" && vadBtn &&
		!vadBtn.classList.contains("vad-listening") && !vadBtn.classList.contains("vad-speech")) {
		vadBtn.classList.add("vad-listening");
	}

	// Restart recorder if it died (e.g. after TTS mute cycle or replying wait)
	if (!vadMediaRecorder || vadMediaRecorder.state === "inactive") {
		vadStartContinuousRecorder();
	}

	var rms = getRMS(vadAnalyser, vadDataArray);
	var now = Date.now();

	// Debug: log RMS every ~1s
	if (!vadMonitorLoop._lastLog || now - vadMonitorLoop._lastLog > 1000) {
		vadMonitorLoop._lastLog = now;
		console.debug("[voice] VAD rms:", rms.toFixed(4), "speech:", vadSpeechDetected, "muted:", vadMutedForTts);
	}

	if (rms > VAD_SPEECH_THRESHOLD) {
		// Speech detected
		vadSilenceStart = 0;

		// Safety valve: auto-stop after 30s of continuous speech
		if (vadSpeechDetected && vadRecordingStart && (now - vadRecordingStart > 30000)) {
			console.debug("[voice] VAD: max duration reached, auto-sending");
			vadSilenceStart = 0;
			vadRecordingStart = 0;
			if (vadBtn) vadBtn.classList.remove("vad-speech", "vad-listening");
			// Stop the continuous recorder — onstop will transcribe and restart
			if (vadMediaRecorder && vadMediaRecorder.state === "recording") {
				vadMediaRecorder.stop();
			}
			vadRafId = requestAnimationFrame(vadMonitorLoop);
			return;
		}

		if (!vadSpeechDetected) {
			// Debounce: require speech for VAD_DEBOUNCE_SPEECH ms before marking
			if (!vadSpeechStart) {
				vadSpeechStart = now;
			} else if (now - vadSpeechStart >= VAD_DEBOUNCE_SPEECH) {
				vadSpeechDetected = true;
				vadSpeechStart = 0;
				vadRecordingStart = now;
				console.debug("[voice] VAD: speech detected (recorder already running)");
				stopAllAudio(); // stop any playing TTS
				if (vadBtn) vadBtn.classList.add("vad-speech");
			}
		}
	} else {
		// Silence
		vadSpeechStart = 0;

		if (vadSpeechDetected) {
			if (!vadSilenceStart) {
				vadSilenceStart = now;
			} else if (now - vadSilenceStart >= VAD_SILENCE_DURATION) {
				// Enough silence after speech — stop recorder and send
				console.debug("[voice] VAD: silence detected, stopping & sending");
				vadRecordingStart = 0;
				vadSilenceStart = 0;
				if (vadBtn) vadBtn.classList.remove("vad-speech", "vad-listening");
				// Stop the continuous recorder — onstop handler will transcribe
				// and restart a new recorder for the next cycle
				if (vadMediaRecorder && vadMediaRecorder.state === "recording") {
					vadMediaRecorder.stop();
				} else {
					// Recorder already stopped somehow — clean up
					vadSpeechDetected = false;
					audioChunks = [];
				}
			}
		}
	}

	vadRafId = requestAnimationFrame(vadMonitorLoop);
}

// ── TTS mute/unmute for VAD ──────────────────────────────────

function onTtsPlay(e) {
	if (!vadActive) return;
	if (e.target?.tagName !== "AUDIO") return;
	console.debug("[voice] VAD: TTS playing, muting VAD + stopping recorder");
	vadMutedForTts = true;
	if (vadBtn) vadBtn.classList.remove("vad-listening", "vad-speech");
	// Stop recorder during TTS to avoid capturing playback audio
	if (vadMediaRecorder && vadMediaRecorder.state === "recording") {
		vadSpeechDetected = false; // discard any partial speech
		audioChunks = [];
		vadMediaRecorder.stop();
		vadMediaRecorder = null;
	}
}

function onTtsEnded(e) {
	if (!vadActive) return;
	if (e.target?.tagName !== "AUDIO") return;
	console.debug("[voice] VAD: TTS ended, resuming VAD after delay");
	vadSpeechDetected = false;
	vadSilenceStart = 0;
	vadSpeechStart = 0;
	// Delay before re-listening — let TTS reverb/echo settle
	setTimeout(() => {
		if (!vadActive) return;
		vadMutedForTts = false;
		// Start fresh recorder for new listening cycle
		vadStartContinuousRecorder();
		if (vadBtn) vadBtn.classList.add("vad-listening");
	}, 400);
}

function onTtsPause(e) {
	if (!vadActive) return;
	if (e.target?.tagName !== "AUDIO") return;
	// Treat pause same as ended for VAD purposes
	vadMutedForTts = false;
}

// ── VAD button click ─────────────────────────────────────────

function onVadClick(e) {
	e.preventDefault();
	if (vadActive) {
		stopVad();
	} else {
		startVad();
	}
}

// ── Init / teardown ──────────────────────────────────────────

export function initVoiceInput(btn) {
	if (!btn) return;
	micBtn = btn;

	checkSttStatus();

	// Toggle mode: click to start/stop
	micBtn.addEventListener("click", onMicClick);

	// Keyboard accessibility
	micBtn.addEventListener("keydown", (e) => {
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			onMicClick(e);
		}
	});

	// Escape cancels recording
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && isRecording) {
			e.preventDefault();
			cancelRecording();
			// Also stop VAD if active
			if (vadActive) stopVad();
		}
	});

	// PTT: global key handlers
	document.addEventListener("keydown", onPttKeyDown);
	document.addEventListener("keyup", onPttKeyUp);

	// Re-check STT status when voice config changes
	window.addEventListener("voice-config-changed", checkSttStatus);
}

export function initVadButton(btn) {
	if (!btn) return;
	vadBtn = btn;
	updateVadButton();
	vadBtn.addEventListener("click", onVadClick);
}

export function teardownVoiceInput() {
	if (vadActive) stopVad();
	if (isRecording && mediaRecorder) {
		mediaRecorder.stop();
	}
	document.removeEventListener("keydown", onPttKeyDown);
	document.removeEventListener("keyup", onPttKeyUp);
	window.removeEventListener("voice-config-changed", checkSttStatus);
	releaseVoiceLock();
	micBtn = null;
	vadBtn = null;
	mediaRecorder = null;
	vadMediaRecorder = null;
	audioChunks = [];
	isRecording = false;
}

export function refreshVoiceStatus() {
	checkSttStatus();
}

/** Update PTT key at runtime. */
export function setPttKey(key) {
	pttKey = key;
	localStorage.setItem("moltis_ptt_key", key);
	console.debug("[voice] PTT key set to:", key);
}

/** Get current PTT key. */
export function getPttKey() {
	return pttKey;
}

/** Check if VAD is currently active. */
export function isVadModeActive() {
	return vadActive;
}


