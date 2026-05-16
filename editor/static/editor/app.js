const uploadForm = document.getElementById("upload-form");
const sidebarStatus = document.getElementById("sidebar-status");
const loadedPanel = document.getElementById("loaded-panel");
const jsonName = document.getElementById("json-name");
const audioList = document.getElementById("audio-list");
const participantSelect = document.getElementById("participant-select");
const changeSpeaker = document.getElementById("change-speaker");
const speakerWarning = document.getElementById("speaker-warning");
const changeAnyway = document.getElementById("change-anyway");
const downloadButton = document.getElementById("download-button");
const downloadWarning = document.getElementById("download-warning");
const downloadAnyway = document.getElementById("download-anyway");
const audioRoot = document.getElementById("audio-root");
const transcriptRoot = document.getElementById("transcript-root");
const message = document.getElementById("message");
const jsonFileSummary = document.getElementById("json-file-summary");
const audioFileSummary = document.getElementById("audio-file-summary");
const outputFolder = document.getElementById("output-folder");
const outputFolderSummary = document.getElementById("output-folder-summary");
const browseOutputFolder = document.getElementById("browse-output-folder");
const workspaceSummary = document.getElementById("workspace-summary");
const emptyState = document.getElementById("empty-state");
const loadingState = document.getElementById("loading-state");
const loadingDetail = document.getElementById("loading-detail");

let appState = null;
let activeParticipantId = null;
let pendingParticipantId = null;
let currentSegments = [];
let dirty = false;
let selected = null;
let fields = null;
let dirtyStatus = null;
let wordButtons = [];
let currentWordButton = null;
let audio = null;
let canvas = null;
let ctx = null;
let clock = null;
let peaks = [];
let activeParticipant = null;
let activePopover = null;
let wordPreviewHandler = null;
let wordPreviewButton = null;

function csrfToken() {
  return document.querySelector("[name=csrfmiddlewaretoken]").value;
}

function showStatus(element, text, kind = "info") {
  element.hidden = false;
  element.className = `status ${kind}`;
  element.textContent = text;
}

function hideStatus(element) {
  element.hidden = true;
  element.textContent = "";
}

function setSaveState(text, kind = "idle") {
  return;
}

function setButtonBusy(button, busy, busyText = "Working...") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    delete button.dataset.originalText;
  }
}

function showMainLoading(detail = "Loading...") {
  emptyState.hidden = true;
  loadingState.hidden = false;
  loadingDetail.textContent = detail;
  audioRoot.innerHTML = "";
  transcriptRoot.innerHTML = "";
}

function hideMainLoading() {
  loadingState.hidden = true;
}

function updateOutputFolderSummary() {
  outputFolderSummary.textContent = outputFolder.value.trim()
    ? `Output folder: ${outputFolder.value.trim()}`
    : "No output folder selected.";
}

function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = value ?? "";
  return span.innerHTML;
}

function formatMs(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "--:--.---";
  const totalSeconds = Math.max(0, Number(milliseconds) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(3).padStart(6, "0")}`;
}

function timeInputToMs(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  if (!match) return Number.NaN;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  return Math.round((minutes * 60 + seconds) * 1000);
}

function cloneSegments(segments) {
  return JSON.parse(JSON.stringify(segments || []));
}

function setDirty(value) {
  dirty = value;
  if (dirtyStatus) {
    dirtyStatus.textContent = dirty ? "Autosave pending" : "Output JSON saved";
    dirtyStatus.style.color = dirty ? "#92400e" : "#166534";
  }
  setSaveState(dirty ? "Unsaved edits" : appState ? "Saved" : "Waiting for upload", dirty ? "dirty" : appState ? "clean" : "idle");
  downloadWarning.hidden = true;
}

function setAutosaveStatus(text, kind = "info") {
  if (!dirtyStatus) return;
  dirtyStatus.textContent = text;
  dirtyStatus.style.color = kind === "error" ? "#991b1b" : kind === "warning" ? "#92400e" : "#166534";
}

function rebuildButtonFromWord(button, word) {
  button.dataset.text = word.text || "";
  button.dataset.start = String(word.start || 0);
  button.dataset.end = String(word.end || 0);
  button.dataset.confidence = String(word.confidence ?? 1);
  button.dataset.userAdded = word.isUserAdded ? "1" : "0";
  button.title = `${formatMs(word.start)} - ${formatMs(word.end)}`;
  if ((word.text || "").trim()) {
    button.textContent = word.text;
  } else {
    button.innerHTML = '<span class="transcript-blank">[blank]</span>';
  }
}

function validateTimings() {
  currentSegments.forEach((segment, segmentIndex) => {
    const words = segment.words || [];
    words.forEach((word, wordIndex) => {
      const currentButton = wordButtons.find(
        (button) =>
          Number(button.dataset.segmentIndex) === segmentIndex &&
          Number(button.dataset.wordIndex) === wordIndex,
      );
      if (!currentButton) return;

      const previousWord = words[wordIndex - 1] || null;
      const nextWord = words[wordIndex + 1] || null;
      const start = Number(word.start || 0);
      const end = Number(word.end || 0);
      const startsBeforePreviousEnds = previousWord && start < Number(previousWord.end || 0);
      const endsAfterNextStarts = nextWord && end > Number(nextWord.start || 0);
      const invertedSelf = end < start;
      const hasBadTiming = startsBeforePreviousEnds || endsAfterNextStarts || invertedSelf;

      currentButton.classList.toggle("bad-timing", Boolean(hasBadTiming));
      currentButton.title = `${formatMs(word.start)} - ${formatMs(word.end)}`;
      if (hasBadTiming) {
        const reasons = [];
        if (invertedSelf) reasons.push("end is before start");
        if (startsBeforePreviousEnds) reasons.push("start overlaps previous word");
        if (endsAfterNextStarts) reasons.push("end overlaps next word");
        currentButton.title = `${currentButton.title} | ${reasons.join(", ")}`;
      }
    });
  });
}

function highlightCurrentMs(currentMs) {
  let nextButton = null;
  for (const button of wordButtons) {
    const start = Number(button.dataset.start || 0);
    const end = Number(button.dataset.end || 0);
    if (currentMs >= start && currentMs <= end) {
      nextButton = button;
      break;
    }
  }

  if (currentWordButton !== nextButton) {
    if (currentWordButton) currentWordButton.classList.remove("current-word");
    currentWordButton = nextButton;
    if (currentWordButton) {
      currentWordButton.classList.add("current-word");
      currentWordButton.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
}

function seekToWord(button) {
  const startMs = Number(button.dataset.start || 0);
  if (audio) {
    audio.currentTime = Math.max(0, startMs / 1000);
    broadcastTime();
  }
  highlightCurrentMs(startMs);
}

function stopWordPreview() {
  if (audio && wordPreviewHandler) {
    audio.removeEventListener("timeupdate", wordPreviewHandler);
  }
  wordPreviewHandler = null;
  if (wordPreviewButton) {
    wordPreviewButton.textContent = "Play word";
    wordPreviewButton.disabled = false;
  }
  wordPreviewButton = null;
}

async function playSelectedWordRange(button) {
  if (!audio) {
    showStatus(message, "No audio is loaded for this speaker.", "error");
    return;
  }

  const updatedRange = applySelectedWordFields();
  if (!updatedRange) return;
  if (!(await autosaveCurrentParticipant())) return;

  const { startMs, endMs } = updatedRange;
  if (endMs <= startMs) {
    showStatus(message, "The preview needs an end time after the start time.", "error");
    return;
  }

  stopWordPreview();
  hideStatus(message);
  wordPreviewButton = button;
  wordPreviewButton.textContent = "Playing...";
  wordPreviewButton.disabled = true;

  const stopAtSeconds = endMs / 1000;
  audio.pause();
  audio.currentTime = Math.max(0, startMs / 1000);
  highlightCurrentMs(startMs);
  broadcastTime();

  wordPreviewHandler = () => {
    if (!audio || audio.currentTime < stopAtSeconds) return;
    audio.pause();
    audio.currentTime = stopAtSeconds;
    broadcastTime();
    stopWordPreview();
  };
  audio.addEventListener("timeupdate", wordPreviewHandler);

  try {
    await audio.play();
  } catch (error) {
    stopWordPreview();
    showStatus(message, "Could not play the selected word range. Try clicking the main audio player once, then retry.", "error");
  }
}

function closeActivePopover() {
  stopWordPreview();
  if (activePopover) {
    activePopover.style.display = "none";
  }
  selected = null;
}

function currentTranscriptScrollTop() {
  const transcriptBox = activePopover?.closest(".transcript-box");
  return transcriptBox ? transcriptBox.scrollTop : null;
}

function applySelectedWordFields() {
  if (!selected) return null;

  const segmentIndex = Number(selected.segmentIndex);
  const wordIndex = Number(selected.wordIndex);
  const words = currentSegments[segmentIndex]?.words || [];
  const word = words[wordIndex];
  if (!word) return null;

  const nextStart = timeInputToMs(fields.start.value);
  const nextEnd = timeInputToMs(fields.end.value);
  if (Number.isNaN(nextStart) || Number.isNaN(nextEnd)) {
    showStatus(message, "Enter start and end times in mm:ss.sss format.", "error");
    return null;
  }

  hideStatus(message);
  word.text = fields.text.value.trim();
  word.start = nextStart;
  word.end = nextEnd;
  rebuildButtonFromWord(selected.button, word);
  validateTimings();
  setDirty(true);
  return { startMs: nextStart, endMs: nextEnd };
}

async function sendWordAction(action) {
  if (!selected) return;

  const segmentIndex = Number(selected.segmentIndex);
  const wordIndex = Number(selected.wordIndex);
  const words = currentSegments[segmentIndex]?.words || [];
  const word = words[wordIndex];
  if (!word) return;

  if (action === "update") {
    if (!applySelectedWordFields()) return;
    if (!(await autosaveCurrentParticipant())) return;
    closeActivePopover();
    return;
  }

  if (action === "add") {
    const restoreScrollTop = currentTranscriptScrollTop();
    const text = fields.newText.value.trim();
    if (!text) return;
    const insertAt = fields.where.value === "Before selected word" ? wordIndex : wordIndex + 1;
    const previousWord = words[insertAt - 1] || null;
    const nextWord = words[insertAt] || null;
    let start = 0;
    let end = 300;
    if (previousWord && nextWord) {
      start = Number(previousWord.end ?? previousWord.start ?? 0);
      end = Number(nextWord.start ?? start + 300);
      if (end <= start) end = start + 300;
    } else if (previousWord) {
      start = Number(previousWord.end ?? previousWord.start ?? 0);
      end = start + 300;
    } else if (nextWord) {
      end = Number(nextWord.start ?? nextWord.end ?? 300);
      start = Math.max(0, end - 300);
    }
    words.splice(insertAt, 0, { text, start, end, confidence: 1, isUserAdded: true });
    setDirty(true);
    closeActivePopover();
    drawTranscript(restoreScrollTop, { segmentIndex, wordIndex: insertAt });
    await autosaveCurrentParticipant();
    return;
  }

  if (action === "delete") {
    const restoreScrollTop = currentTranscriptScrollTop();
    words.splice(wordIndex, 1);
    setDirty(true);
    closeActivePopover();
    drawTranscript(restoreScrollTop);
    await autosaveCurrentParticipant();
  }
}

function showPopover(button, popover, box) {
  seekToWord(button);
  selected = {
    segmentIndex: button.dataset.segmentIndex,
    wordIndex: button.dataset.wordIndex,
    button,
  };

  fields.text.value = button.dataset.text || "";
  fields.start.value = formatMs(Number(button.dataset.start || 0));
  fields.end.value = formatMs(Number(button.dataset.end || 0));
  fields.newText.value = "new word";
  fields.where.value = "After selected word";

  popover.style.display = "block";
  activePopover = popover;
  const boxRect = box.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  const gap = 14;
  const left = Math.min(
    box.clientWidth - popover.offsetWidth - 12,
    Math.max(8, buttonRect.left - boxRect.left),
  );
  const belowTop = box.scrollTop + buttonRect.bottom - boxRect.top + gap;
  const aboveTop = box.scrollTop + buttonRect.top - boxRect.top - popover.offsetHeight - gap;
  const maxTop = box.scrollTop + box.clientHeight - popover.offsetHeight - 12;
  const hasRoomBelow = belowTop + popover.offsetHeight <= box.scrollTop + box.clientHeight - 12;
  const hasRoomAbove = aboveTop >= box.scrollTop + 8;
  let top = belowTop;
  if (!hasRoomBelow && hasRoomAbove) {
    top = aboveTop;
  } else if (!hasRoomBelow) {
    top = maxTop;
  }
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${Math.max(8, top)}px`;
  fields.text.focus();
  validateTimings();
}

async function saveAll(saveButton = null) {
  if (!activeParticipantId) return;
  setButtonBusy(saveButton, true, "Saving...");
  setSaveState("Saving...", "busy");
  setAutosaveStatus("Saving output JSON...", "warning");
  try {
    const response = await fetch(`/api/save/${encodeURIComponent(activeParticipantId)}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": csrfToken(),
      },
      body: JSON.stringify({ segments: currentSegments }),
    });
    const payload = await response.json();
    if (!response.ok) {
      showStatus(message, payload.error || "Could not save edits.", "error");
      setSaveState("Save failed", "dirty");
      setAutosaveStatus("Autosave failed", "error");
      dirty = true;
      return;
    }
    setDirty(false);
    hideStatus(message);
    return payload;
  } finally {
    setButtonBusy(saveButton, false);
  }
}

async function autosaveCurrentParticipant() {
  const payload = await saveAll();
  return Boolean(payload);
}

function drawTranscript(restoreScrollTop = null, openTarget = null) {
  transcriptRoot.innerHTML = "";
  wordButtons = [];
  currentWordButton = null;
  stopWordPreview();
  activePopover = null;

  if (!currentSegments.length) {
    showStatus(message, "This participant has no updatedTranscription segments.", "warning");
    return;
  }

  dirtyStatus = null;

  const box = document.createElement("div");
  box.className = "transcript-box";

  currentSegments.forEach((segment, segmentIndex) => {
    if (segmentIndex > 0) {
      box.insertAdjacentHTML("beforeend", `<br><span class="segment-break">Segment ${segmentIndex + 1}</span><br>`);
    }

    (segment.words || []).forEach((word, wordIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "transcript-word";
      button.dataset.segmentIndex = String(segmentIndex);
      button.dataset.wordIndex = String(wordIndex);
      rebuildButtonFromWord(button, word);
      box.appendChild(button);
      box.appendChild(document.createTextNode(" "));
      wordButtons.push(button);
    });
  });

  const popover = document.createElement("div");
  popover.className = "word-popover";
  popover.innerHTML = `
    <h4>Edit word</h4>
    <label>Word / token<input data-field="text" type="text"></label>
    <div class="popover-row">
      <label>Start (mm:ss.sss)<input data-field="start" type="text" placeholder="01:23.450"></label>
      <label>End (mm:ss.sss)<input data-field="end" type="text" placeholder="01:24.100"></label>
    </div>
    <div class="popover-row">
      <label>New word<input data-field="newText" type="text" value="new word"></label>
      <label>Position
        <select data-field="where">
          <option>After selected word</option>
          <option>Before selected word</option>
        </select>
      </label>
    </div>
    <div class="popover-actions">
      <button type="button" class="play-preview-button" data-action="play-preview">Play word</button>
      <button type="button" class="save-button" data-action="update">Save</button>
      <button type="button" class="add-button" data-action="add">Add</button>
      <button type="button" class="delete-button" data-action="delete">Delete</button>
      <button type="button" class="cancel-button" data-action="cancel">Close</button>
    </div>
  `;
  box.appendChild(popover);
  transcriptRoot.appendChild(box);

  fields = {
    text: popover.querySelector('[data-field="text"]'),
    start: popover.querySelector('[data-field="start"]'),
    end: popover.querySelector('[data-field="end"]'),
    newText: popover.querySelector('[data-field="newText"]'),
    where: popover.querySelector('[data-field="where"]'),
  };

  box.querySelectorAll(".transcript-word").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      showPopover(button, popover, box);
    });
  });

  popover.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      if (action === "cancel") {
        closeActivePopover();
        return;
      }
      if (action === "play-preview") {
        await playSelectedWordRange(button);
        return;
      }
      await sendWordAction(action);
    });
  });

  box.addEventListener("click", (event) => {
    const clickedWord = event.target.closest(".transcript-word");
    const clickedPopover = popover.contains(event.target);
    if (!clickedWord && !clickedPopover) {
      closeActivePopover();
    }
  });

  setDirty(dirty);
  validateTimings();
  if (restoreScrollTop !== null) {
    box.scrollTop = restoreScrollTop;
  }
  if (openTarget) {
    const newWordButton = wordButtons.find(
      (button) =>
        Number(button.dataset.segmentIndex) === openTarget.segmentIndex &&
        Number(button.dataset.wordIndex) === openTarget.wordIndex,
    );
    if (newWordButton) {
      newWordButton.scrollIntoView({ block: "center", inline: "nearest" });
      showPopover(newWordButton, popover, box);
    }
  }
}

function formatSeconds(seconds) {
  return formatMs((seconds || 0) * 1000);
}

function drawWaveform() {
  if (!canvas || !ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const mid = height / 2;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, width, height);

  const barWidth = Math.max(1, width / Math.max(1, peaks.length));
  for (let i = 0; i < peaks.length; i += 1) {
    const peak = Math.min(1, Math.pow(peaks[i] || 0, 0.55) * 1.75);
    const barHeight = Math.max(3, peak * (height - 10));
    const x = i * barWidth;
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(x, mid - barHeight / 2, Math.max(1, barWidth - 1), barHeight);
  }

  const progress = audio && audio.duration ? audio.currentTime / audio.duration : 0;
  ctx.fillStyle = "rgba(248, 250, 252, 0.22)";
  ctx.fillRect(0, 0, width * progress, height);
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(width * progress, 0);
  ctx.lineTo(width * progress, height);
  ctx.stroke();
}

function broadcastTime() {
  if (!audio) return;
  if (clock) {
    clock.textContent = `${formatSeconds(audio.currentTime)} / ${formatSeconds(audio.duration)}`;
  }
  highlightCurrentMs(audio.currentTime * 1000);
  drawWaveform();
}

function renderAudio(audioData) {
  stopWordPreview();
  audioRoot.innerHTML = "";
  audio = null;
  peaks = audioData?.peaks || [];

  if (!audioData) return;
  if (audioData.error) {
    showStatus(message, audioData.error, "error");
    return;
  }

  const panel = document.createElement("div");
  panel.className = "audio-panel";
  panel.innerHTML = `
    <div class="audio-title">${escapeText(audioData.title || "Audio")}</div>
    <canvas class="waveform" width="1200" height="64"></canvas>
    <div class="audio-controls">
      <button type="button" data-skip="-5">-5s</button>
      <button type="button" data-skip="5">+5s</button>
      <label>Speed
        <select data-speed>
          <option value="0.5">0.5x</option>
          <option value="0.75">0.75x</option>
          <option value="1" selected>1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>
      </label>
      <span class="audio-clock">00:00.000 / 00:00.000</span>
    </div>
    <audio preload="auto" src="${audioData.url}" controls style="width: 100%; margin-top: 0.55rem;"></audio>
  `;
  audioRoot.appendChild(panel);

  audio = panel.querySelector("audio");
  canvas = panel.querySelector("canvas");
  ctx = canvas.getContext("2d");
  clock = panel.querySelector(".audio-clock");
  const speed = panel.querySelector("[data-speed]");

  canvas.addEventListener("click", (event) => {
    if (!audio.duration) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    audio.currentTime = Math.max(0, Math.min(audio.duration, ratio * audio.duration));
    broadcastTime();
  });
  panel.querySelectorAll("[data-skip]").forEach((button) => {
    button.addEventListener("click", () => {
      audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + Number(button.dataset.skip)));
      broadcastTime();
    });
  });
  speed.addEventListener("change", () => {
    audio.playbackRate = Number(speed.value);
  });
  audio.addEventListener("timeupdate", broadcastTime);
  audio.addEventListener("loadedmetadata", broadcastTime);
  drawWaveform();
}

function renderLoadedState(state) {
  appState = state;
  loadedPanel.hidden = false;
  emptyState.hidden = true;
  hideStatus(sidebarStatus);
  workspaceSummary.innerHTML = `
    <strong>${state.participants.length} speaker/channel${state.participants.length === 1 ? "" : "s"}</strong>
    <span>${state.audioFiles.length} audio file${state.audioFiles.length === 1 ? "" : "s"} loaded</span>
    <span>Autosaving to ${escapeText(state.outputFilePath || state.outputName || "selected output JSON")}</span>
  `;
  jsonName.innerHTML = `JSON: <code>${escapeText(state.jsonName || "labeling.json")}</code>`;
  audioList.innerHTML = "";
  if (state.audioFiles.length) {
    state.audioFiles.forEach((audioName) => {
      const item = document.createElement("li");
      item.innerHTML = `<code>${escapeText(audioName)}</code>`;
      audioList.appendChild(item);
    });
  } else {
    const item = document.createElement("li");
    item.textContent = "No WAV files loaded.";
    audioList.appendChild(item);
  }
  downloadAnyway.href = state.downloadUrl;
  setDirty(false);

  participantSelect.innerHTML = "";
  state.participants.forEach((participant) => {
    const option = document.createElement("option");
    option.value = participant.id;
    option.textContent = participant.label;
    participantSelect.appendChild(option);
  });

  if (state.participants.length) {
    activeParticipantId = activeParticipantId || state.participants[0].id;
    participantSelect.value = activeParticipantId;
    loadParticipant(activeParticipantId, "Loading audio and transcript...");
  } else {
    hideMainLoading();
    showStatus(message, "No participants found in the uploaded JSON.", "error");
  }
}

async function loadParticipant(participantId, loadingDetailText = "Loading speaker...") {
  hideStatus(message);
  speakerWarning.hidden = true;
  showMainLoading(loadingDetailText);
  setSaveState("Loading speaker...", "busy");
  const response = await fetch(`/api/participant/${encodeURIComponent(participantId)}/`);
  const payload = await response.json();
  if (!response.ok) {
    hideMainLoading();
    showStatus(message, payload.error || "Could not load participant.", "error");
    setSaveState("Load failed", "dirty");
    return;
  }
  activeParticipantId = participantId;
  activeParticipant = appState?.participants.find((participant) => participant.id === participantId) || null;
  participantSelect.value = participantId;
  currentSegments = cloneSegments(payload.segments);
  setDirty(false);
  renderAudio(payload.audio);
  if (payload.warning) {
    showStatus(message, payload.warning, "warning");
  }
  drawTranscript();
  hideMainLoading();
}

uploadForm.addEventListener("change", () => {
  const jsonFile = uploadForm.elements.json_file.files[0];
  jsonFileSummary.textContent = jsonFile ? `${jsonFile.name} selected.` : "No JSON selected.";

  const audioFiles = Array.from(uploadForm.elements.audio_files.files || []);
  if (!audioFiles.length) {
    audioFileSummary.textContent = "No audio selected yet.";
  } else if (audioFiles.length === 1) {
    audioFileSummary.textContent = `${audioFiles[0].name} selected.`;
  } else {
    audioFileSummary.textContent = `${audioFiles.length} audio files selected.`;
  }
  updateOutputFolderSummary();
});

outputFolder.addEventListener("input", updateOutputFolderSummary);

browseOutputFolder.addEventListener("click", async () => {
  setButtonBusy(browseOutputFolder, true, "Browsing...");
  try {
    const response = await fetch("/api/select-output-folder/", {
      method: "POST",
      headers: { "X-CSRFToken": csrfToken() },
    });
    const payload = await response.json();
    if (!response.ok) {
      showStatus(sidebarStatus, payload.error || "Could not open the folder picker.", "error");
      return;
    }
    if (payload.folder) {
      outputFolder.value = payload.folder;
      updateOutputFolderSummary();
      hideStatus(sidebarStatus);
    }
  } finally {
    setButtonBusy(browseOutputFolder, false);
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideStatus(message);
  if (!outputFolder.value.trim()) {
    showStatus(sidebarStatus, "Please choose an output folder before loading files.", "error");
    return;
  }
  const submitButton = uploadForm.querySelector("button[type=submit]");
  setButtonBusy(submitButton, true, "Loading files...");
  setSaveState("Loading files...", "busy");
  showStatus(sidebarStatus, "Processing uploaded files...", "info");
  showMainLoading("Processing uploaded files. This can take a few seconds for large audio.");

  try {
    const response = await fetch("/api/load/", {
      method: "POST",
      headers: { "X-CSRFToken": csrfToken() },
      body: new FormData(uploadForm),
    });
    const payload = await response.json();
    if (!response.ok) {
      hideMainLoading();
      if (!appState) emptyState.hidden = false;
      showStatus(sidebarStatus, payload.error || "Could not load files.", "error");
      setSaveState(appState ? "Saved" : "Waiting for upload", appState ? "clean" : "idle");
      return;
    }
    activeParticipantId = null;
    renderLoadedState(payload);
    hideStatus(message);
  } finally {
    setButtonBusy(submitButton, false);
  }
});

changeSpeaker.addEventListener("click", () => {
  const nextParticipantId = participantSelect.value;
  if (nextParticipantId !== activeParticipantId && dirty) {
    pendingParticipantId = nextParticipantId;
    speakerWarning.hidden = false;
  } else {
    loadParticipant(nextParticipantId);
  }
});

changeAnyway.addEventListener("click", () => {
  if (pendingParticipantId) {
    loadParticipant(pendingParticipantId);
    pendingParticipantId = null;
  }
});

downloadButton.addEventListener("click", () => {
  if (dirty) {
    downloadWarning.hidden = false;
    return;
  }
  window.location.href = appState?.downloadUrl || "/download/";
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTyping =
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveAll();
    return;
  }

  if (event.key === " " && !isTyping && audio) {
    event.preventDefault();
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

