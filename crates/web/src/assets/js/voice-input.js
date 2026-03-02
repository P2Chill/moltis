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
var voiceLockChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("moltis_voice_lock") : null;
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
var VAD_SENSITIVITY = parseInt(localStorage.getItem("moltis_vad_sensitivity") || "50", 10);
var VAD_SPEECH_THRESHOLD = sensitivityToThreshold(VAD_SENSITIVITY);

/** Map sensitivity percentage (0-100) to RMS threshold.
 *  0% = least sensitive (threshold 0.08), 100% = most sensitive (threshold 0.005). */
function sensitivityToThreshold(pct) {
	var clamped = Math.max(0, Math.min(100, pct));
	// Exponential curve: low sensitivity = high threshold, high sensitivity = low threshold
	return 0.08 * (0.005 / 0.08) ** (clamped / 100);
}
var VAD_SILENCE_DURATION = 2500; // ms of silence before auto-send
var VAD_DEBOUNCE_SPEECH = 250; // ms of speech before we consider it speech
var vadSpeechStart = 0;
var vadRecordingStart = 0;
var vadMediaRecorder = null; // separate recorder for VAD continuous mode
var vadTranscribing = false; // true during transcription fetch, prevents recorder restart races

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

/** Update mic button visibility based on STT configuration. */
function updateMicButton() {
	if (!micBtn) return;
	micBtn.style.display = sttConfigured && isVoiceEnabled() ? "" : "none";
	micBtn.disabled = !S.connected;
	micBtn.title = isStarting ? t("chat:micStarting") : isRecording ? t("chat:micStopAndSend") : t("chat:micTooltip");
}

// ── VAD button ───────────────────────────────────────────────

function updateVadButton() {
	if (!vadBtn) return;
	vadBtn.style.display = sttConfigured && isVoiceEnabled() ? "" : "none";
	vadBtn.disabled = !S.connected;
	vadBtn.title = vadActive ? t("chat:vadStopTooltip") : t("chat:vadTooltip");
}

// ── Audio helpers ────────────────────────────────────────────

/** Pause all currently playing audio elements on the page. */
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

/** Start recording audio from the microphone. */
async function startRecording(opts) {
	if (isRecording || isStarting || !sttConfigured) return;

	var fromVad = opts?.fromVad === true;
	var stream = opts?.stream || null;

	// Stop any playing audio so the mic doesn't pick up speaker output.
	if (!fromVad) stopAllAudio();

	isStarting = true;
	if (micBtn && !fromVad) {
		micBtn.classList.add("starting");
		micBtn.setAttribute("aria-busy", "true");
		micBtn.title = t("chat:micStarting");
	}

	try {
		if (!stream) {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
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
				micBtn.title = t("chat:micStopAndSend");
			}
		}

		// Use webm/opus if available, fall back to audio/webm
		var mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";

		mediaRecorder = new MediaRecorder(stream, { mimeType });

		mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) {
				audioChunks.push(e.data);
				showRecordingUi();
			}
		};

		// Recorder start means stop is now valid; visual indicator waits for actual audio data.
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
			micBtn.title = t("chat:micTooltip");
		}
		console.error("Failed to start recording:", err);
		// Show user-friendly error
		if (err.name === "NotAllowedError") {
			alert(t("settings:voice.micDenied"));
		} else if (err.name === "NotFoundError") {
			alert(t("settings:voice.noMicFound"));
		}
	}
}

/** Stop recording and trigger transcription. */
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
		micBtn.title = t("chat:voiceTranscribing");
	}

	// Stop the recorder, which triggers onstop -> transcribeAudio
	mediaRecorder.stop();
}

/** Cancel recording without sending — discards audio chunks. */
function cancelRecording() {
	if (!(isRecording && mediaRecorder)) return;

	console.debug("[voice] recording cancelled via Escape");

	// Prevent onstop from transcribing by clearing chunks first.
	audioChunks = [];

	isStarting = false;
	isRecording = false;
	if (micBtn) {
		micBtn.classList.remove("starting", "recording");
		micBtn.removeAttribute("aria-busy");
		micBtn.setAttribute("aria-pressed", "false");
		micBtn.title = t("chat:micTooltip");
	}
	if (vadBtn) vadBtn.classList.remove("vad-speech");

	// Stop the recorder — onstop will see empty chunks and bail out.
	mediaRecorder.stop();
}

// ── Transcription UI helpers ─────────────────────────────────

/** Create transcribing indicator element. */
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

/** Update transcribing element with a message. */
function updateTranscribingMessage(message, isError) {
	if (!transcribingEl) return;
	transcribingEl.textContent = "";
	var text = document.createElement("span");
	text.className = "voice-transcribing-text";
	text.classList.add(isError ? "text-[var(--error)]" : "text-[var(--muted)]");
	text.textContent = message;
	transcribingEl.appendChild(text);
}

/** Show a temporary message then remove the transcribing element. */
function showTemporaryMessage(message, isError, delayMs) {
	updateTranscribingMessage(message, isError);
	setTimeout(() => {
		if (transcribingEl) {
			transcribingEl.remove();
			transcribingEl = null;
		}
	}, delayMs);
}

/** Remove transcribing indicator and reset mic button state. */
function cleanupTranscribingState() {
	isStarting = false;
	if (micBtn) {
		micBtn.classList.remove("starting");
		micBtn.removeAttribute("aria-busy");
		micBtn.classList.remove("transcribing");
		micBtn.title = t("chat:micTooltip");
	}
	if (transcribingEl) {
		transcribingEl.remove();
		transcribingEl = null;
	}
}

// ── Send transcribed message ─────────────────────────────────

/** Send transcribed text as a chat message. */
function sendTranscribedMessage(text, audioFilename) {
	// Unlock audio playback while we still have user-gesture context.
	warmAudioPlayback();

	// Add user message to chat (like sendChat does), including the recorded
	// audio player when we have a saved filename from the upload endpoint.
	if (audioFilename) {
		var userEl = chatAddMsg("user", "", true);
		if (userEl) {
			var audioSrc = `/api/sessions/${encodeURIComponent(S.activeSessionKey)}/media/${encodeURIComponent(audioFilename)}`;
			renderAudioPlayer(userEl, audioSrc);
			if (text) {
				var textWrap = document.createElement("div");
				textWrap.className = "mt-2";
				// Safe: renderMarkdown escapes untrusted content before formatting tags.
				textWrap.innerHTML = renderMarkdown(text); // eslint-disable-line no-unsanitized/property
				userEl.appendChild(textWrap);
			}
		}
	} else {
		chatAddMsg("user", renderMarkdown(text), true);
	}

	// Send the message
	var chatParams = { text: text, _input_medium: "voice" };
	if (audioFilename) {
		chatParams._audio_filename = audioFilename;
	}
	var selectedModel = S.selectedModelId;
	if (selectedModel) {
		chatParams.model = selectedModel;
	}
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

/** Send recorded audio to STT service for transcription via upload endpoint. */
async function transcribeAudio() {
	if (audioChunks.length === 0) {
		cleanupTranscribingState();
		return;
	}

	// Show transcribing indicator in chat immediately
	if (S.chatMsgBox) {
		transcribingEl = createTranscribingIndicator(t("chat:voiceTranscribingMessage"), false);
		S.chatMsgBox.appendChild(transcribingEl);
		S.chatMsgBox.scrollTop = S.chatMsgBox.scrollHeight;
	}

	try {
		var blob = new Blob(audioChunks, { type: "audio/webm" });
		audioChunks = [];

		// Skip tiny blobs that are just WebM headers with no real audio —
		// these cause 400 errors from the STT API.
		if (blob.size < 2000) {
			console.debug("[voice] skipping tiny blob:", blob.size, "bytes");
			cleanupTranscribingState();
			return;
		}

		// Validate EBML header (WebM magic bytes: 1A 45 DF A3).
		// Corrupt blobs from recorder restart races won't have proper headers.
		var headerBytes = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
		if (headerBytes[0] !== 0x1a || headerBytes[1] !== 0x45 || headerBytes[2] !== 0xdf || headerBytes[3] !== 0xa3) {
			console.warn("[voice] corrupt WebM blob (bad EBML header), discarding. size:", blob.size);
			cleanupTranscribingState();
			return;
		}

		// Timeout after 15s to prevent vadTranscribing from getting stuck forever
		var abortCtrl = new AbortController();
		var fetchTimeout = setTimeout(() => abortCtrl.abort(), 15000);
		var resp = await fetch(`/api/sessions/${encodeURIComponent(S.activeSessionKey)}/upload?transcribe=true`, {
			method: "POST",
			headers: { "Content-Type": blob.type || "audio/webm" },
			body: blob,
			signal: abortCtrl.signal,
		});
		clearTimeout(fetchTimeout);
		var res = await resp.json();

		if (micBtn) {
			micBtn.classList.remove("transcribing");
			micBtn.title = t("chat:micTooltip");
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
			micBtn.title = t("chat:micTooltip");
		}
		showTemporaryMessage("Transcription error", true, 4000);
	}
}

// ── Toggle mode (mic button click) ───────────────────────────

/** Handle click on mic button - toggle recording. */
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
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
	} catch (err) {
		console.error("[voice] VAD mic access failed:", err);
		if (err.name === "NotAllowedError") {
			alert(t("settings:voice.micDenied"));
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
		vadBtn.title = t("chat:vadStopTooltip");
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
	if (!(vadActive && vadStream)) return;
	if (vadTranscribing) return; // Don't restart while transcription is in flight
	audioChunks = [];
	var mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
	vadMediaRecorder = new MediaRecorder(vadStream, { mimeType });
	vadMediaRecorder.ondataavailable = (e) => {
		if (e.data.size > 0) audioChunks.push(e.data);
	};
	vadMediaRecorder.onstop = async () => {
		if (vadBtn) vadBtn.classList.remove("vad-speech");
		// Only transcribe if we actually detected speech in this cycle
		if (audioChunks.length > 0 && vadSpeechDetected) {
			vadSpeechDetected = false;
			vadTranscribing = true; // Prevent monitor loop from restarting recorder during fetch
			try {
				await transcribeAudio();
			} finally {
				vadTranscribing = false;
			}
		} else {
			audioChunks = [];
			vadSpeechDetected = false;
		}
		// Restart recorder for next listening cycle (if still active and not muted)
		if (vadActive && !vadMutedForTts) {
			vadStartContinuousRecorder();
		}
	};
	vadMediaRecorder.start(250); // collect data every 250ms
	console.debug("[voice] VAD continuous recorder started");
}

/** Reacquire microphone stream when the original track dies.
 *  Reconnects the AnalyserNode so RMS monitoring works again. */
async function vadReacquireStream() {
	try {
		var newStream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		vadStream = newStream;
		// Reconnect analyser to new stream
		if (vadAudioCtx && vadAnalyser) {
			var source = vadAudioCtx.createMediaStreamSource(newStream);
			source.connect(vadAnalyser);
		}
		// Restart recorder with new stream
		if (vadMediaRecorder && vadMediaRecorder.state === "recording") {
			vadMediaRecorder.stop();
		} else {
			vadStartContinuousRecorder();
		}
		console.debug("[voice] VAD: stream reacquired successfully");
	} catch (err) {
		console.error("[voice] VAD: failed to reacquire stream:", err);
		stopVad();
	}
}

function stopVad() {
	if (!vadActive) return;
	console.debug("[voice] VAD stopping");

	vadActive = false;
	vadSpeechDetected = false;
	vadTranscribing = false;

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
		vadAudioCtx.close().catch(() => {
			/* ignore */
		});
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
		vadBtn.title = t("chat:vadTooltip");
	}

	releaseVoiceLock();

	document.removeEventListener("play", onTtsPlay, true);
	document.removeEventListener("ended", onTtsEnded, true);
	document.removeEventListener("pause", onTtsPause, true);
}

function vadMonitorLoop() {
	if (!vadActive) return;

	// Health check: resume AudioContext if browser suspended it (happens after
	// extended use without direct user interaction — RMS reads 0 forever).
	if (vadAudioCtx && vadAudioCtx.state === "suspended") {
		console.debug("[voice] VAD: AudioContext suspended, resuming");
		vadAudioCtx.resume();
	}

	// Health check: if the mic stream track ended, reacquire it.
	if (vadStream) {
		var track = vadStream.getAudioTracks()[0];
		if (!track || track.readyState !== "live") {
			console.warn("[voice] VAD: mic track died, reacquiring");
			vadReacquireStream();
			vadRafId = requestAnimationFrame(vadMonitorLoop);
			return;
		}
	}

	// Skip monitoring while TTS is playing or while we are transcribing
	if (vadMutedForTts || micBtn?.classList.contains("transcribing")) {
		// Safety fallback: if muted for TTS for over 10s, the ended event was missed
		if (vadMutedForTts && !vadMonitorLoop._muteStart) {
			vadMonitorLoop._muteStart = Date.now();
		} else if (vadMutedForTts && Date.now() - vadMonitorLoop._muteStart > 10000) {
			console.debug("[voice] VAD: TTS mute timeout, force-resuming");
			vadMutedForTts = false;
			vadMonitorLoop._muteStart = 0;
			vadSpeechDetected = false;
			vadStartContinuousRecorder();
			if (vadBtn) vadBtn.classList.add("vad-listening");
		}
		vadRafId = requestAnimationFrame(vadMonitorLoop);
		return;
	}
	vadMonitorLoop._muteStart = 0; // reset when not muted

	// Also skip if the session is still replying (waiting for AI response)
	var activeSession = sessionStore.getByKey(S.activeSessionKey);
	if (activeSession?.replying.value) {
		vadRafId = requestAnimationFrame(vadMonitorLoop);
		return;
	}

	// Show listening state when recorder is running
	if (
		vadMediaRecorder &&
		vadMediaRecorder.state === "recording" &&
		vadBtn &&
		!vadBtn.classList.contains("vad-listening") &&
		!vadBtn.classList.contains("vad-speech")
	) {
		vadBtn.classList.add("vad-listening");
	}

	// Restart recorder if it died (e.g. after TTS mute cycle or replying wait)
	// Skip if transcription is in-flight — onstop handler will restart after fetch.
	if (!vadTranscribing && (!vadMediaRecorder || vadMediaRecorder.state === "inactive")) {
		vadStartContinuousRecorder();
	}

	var rms = getRMS(vadAnalyser, vadDataArray);
	var now = Date.now();

	// Debug: log RMS every ~1s
	if (!vadMonitorLoop._lastLog || now - vadMonitorLoop._lastLog > 1000) {
		vadMonitorLoop._lastLog = now;
		console.debug(
			"[voice] VAD rms:",
			rms.toFixed(4),
			"speech:",
			vadSpeechDetected,
			"muted:",
			vadMutedForTts,
			"transcribing:",
			vadTranscribing,
			"ctx:",
			vadAudioCtx?.state,
		);
	}

	if (rms > VAD_SPEECH_THRESHOLD) {
		// Speech detected
		vadSilenceStart = 0;

		// Safety valve: auto-stop after 30s of continuous speech
		if (vadSpeechDetected && vadRecordingStart && now - vadRecordingStart > 30000) {
			console.debug("[voice] VAD: max duration reached, auto-sending");
			vadSilenceStart = 0;
			vadRecordingStart = 0;
			if (vadBtn) vadBtn.classList.remove("vad-speech", "vad-listening");
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
				if (vadMediaRecorder && vadMediaRecorder.state === "recording") {
					vadMediaRecorder.stop();
				} else {
					vadSpeechDetected = false;
					audioChunks = [];
				}
			}
		}
	}

	vadRafId = requestAnimationFrame(vadMonitorLoop);
}

// ── TTS mute/unmute for VAD ──────────────────────────────────

/** Check if any audio element on the page is currently playing. */
function isAnyAudioPlaying() {
	return Array.from(document.querySelectorAll("audio")).some((a) => !(a.paused || a.ended));
}

function onTtsPlay(e) {
	if (!vadActive) return;
	if (e.target?.tagName !== "AUDIO") return;
	console.debug("[voice] VAD: TTS playing, muting VAD + stopping recorder");
	vadMutedForTts = true;
	if (vadBtn) vadBtn.classList.remove("vad-listening", "vad-speech");
	if (vadMediaRecorder && vadMediaRecorder.state === "recording") {
		vadSpeechDetected = false;
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
	setTimeout(() => {
		if (!vadActive) return;
		// Don't unmute if another audio chunk started playing in the meantime
		if (isAnyAudioPlaying()) {
			console.debug("[voice] VAD: another audio still playing, staying muted");
			return;
		}
		vadMutedForTts = false;
		// Only restart recorder if transcription isn't in-flight
		if (!vadTranscribing) {
			vadStartContinuousRecorder();
			if (vadBtn) vadBtn.classList.add("vad-listening");
		}
	}, 400);
}

function onTtsPause(e) {
	if (!vadActive) return;
	if (e.target?.tagName !== "AUDIO") return;
	// Check if audio actually ended (paused at the end)
	var audio = e.target;
	if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.1)) {
		// Treat as ended — restart VAD
		console.debug("[voice] VAD: TTS paused at end, treating as ended");
		vadSpeechDetected = false;
		vadSilenceStart = 0;
		vadSpeechStart = 0;
		setTimeout(() => {
			if (!vadActive) return;
			// Don't unmute if another audio chunk started playing
			if (isAnyAudioPlaying()) {
				console.debug("[voice] VAD: another audio still playing, staying muted");
				return;
			}
			vadMutedForTts = false;
			// Only restart recorder if transcription isn't in-flight
			if (!vadTranscribing) {
				vadStartContinuousRecorder();
				if (vadBtn) vadBtn.classList.add("vad-listening");
			}
		}, 400);
	} else if (!isAnyAudioPlaying()) {
		// Manual pause mid-playback — only unmute if nothing else is playing
		vadMutedForTts = false;
	}
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

/** Initialize voice input with the mic button element. */
export function initVoiceInput(btn) {
	if (!btn) return;

	micBtn = btn;

	// Check STT status on init
	checkSttStatus();

	// Click to toggle recording (start on first click, stop on second)
	micBtn.addEventListener("click", onMicClick);

	// Keyboard accessibility: Space/Enter to toggle
	micBtn.addEventListener("keydown", (e) => {
		if (e.key === " " || e.key === "Enter") {
			e.preventDefault();
			onMicClick(e);
		}
	});

	// Escape cancels recording without sending.
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && isRecording) {
			e.preventDefault();
			cancelRecording();
			if (vadActive) stopVad();
		}
	});

	// PTT: global key handlers
	document.addEventListener("keydown", onPttKeyDown);
	document.addEventListener("keyup", onPttKeyUp);

	// Re-check STT status when voice config changes
	window.addEventListener("voice-config-changed", checkSttStatus);
}

/** Initialize VAD (conversation mode) button. */
export function initVadButton(btn) {
	if (!btn) return;
	vadBtn = btn;
	updateVadButton();
	vadBtn.addEventListener("click", onVadClick);
}

/** Teardown voice input module. */
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
	vadTranscribing = false;
	audioChunks = [];
	isRecording = false;
}

/** Re-check STT status (can be called externally). */
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

/** Update VAD sensitivity at runtime (0-100). */
export function setVadSensitivity(pct) {
	VAD_SENSITIVITY = Math.max(0, Math.min(100, pct));
	VAD_SPEECH_THRESHOLD = sensitivityToThreshold(VAD_SENSITIVITY);
	localStorage.setItem("moltis_vad_sensitivity", String(VAD_SENSITIVITY));
	console.debug("[voice] VAD sensitivity set to:", VAD_SENSITIVITY, "threshold:", VAD_SPEECH_THRESHOLD.toFixed(4));
}

/** Get current VAD sensitivity (0-100). */
export function getVadSensitivity() {
	return VAD_SENSITIVITY;
}
