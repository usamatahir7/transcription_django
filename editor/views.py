import json
import math
import mimetypes
import re
import shutil
import wave
from io import BytesIO
from pathlib import Path

from django.conf import settings
from django.http import FileResponse, Http404, HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.utils.text import get_valid_filename
from django.views.decorators.http import require_GET, require_POST, require_safe


AUDIO_EXTENSIONS = {".wav", ".wave"}
SESSION_KEY = "editor_workspace"
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


def index(request: HttpRequest) -> HttpResponse:
    if request.session.session_key:
        root = settings.MEDIA_ROOT / "sessions" / request.session.session_key
        if root.exists():
            shutil.rmtree(root)
    return render(request, "editor/index.html")


def workspace_root(request: HttpRequest) -> Path:
    if not request.session.session_key:
        request.session.save()
    session_key = request.session.session_key or "anonymous"
    root = settings.MEDIA_ROOT / "sessions" / session_key
    root.mkdir(parents=True, exist_ok=True)
    return root


def metadata_path(root: Path) -> Path:
    return root / "metadata.json"


def original_data_path(root: Path) -> Path:
    return root / "original.json"


def data_path(root: Path) -> Path:
    return root / "output.json"


def output_data_path(root: Path, metadata: dict | None = None) -> Path:
    metadata = metadata if metadata is not None else load_metadata(root)
    output_file_path = metadata.get("output_file_path")
    if output_file_path:
        return Path(output_file_path)
    return data_path(root)


def audio_root(root: Path) -> Path:
    path = root / "audio"
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_json_file(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_file(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(f"{path.suffix}.tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    temp_path.replace(path)


def ensure_output_folder(folder: str) -> Path:
    folder = folder.strip()
    if not folder:
        raise ValueError("Please choose an output folder.")
    output_folder = Path(folder).expanduser()
    output_folder.mkdir(parents=True, exist_ok=True)
    if not output_folder.is_dir():
        raise ValueError("The selected output location is not a folder.")
    return output_folder


def unique_output_path(output_folder: Path, base_name: str) -> Path:
    candidate = output_folder / base_name
    if not candidate.exists():
        return candidate

    suffix = candidate.suffix
    stem = candidate.stem
    counter = 1
    while True:
        next_candidate = output_folder / f"{stem} ({counter}){suffix}"
        if not next_candidate.exists():
            return next_candidate
        counter += 1


def load_metadata(root: Path) -> dict:
    path = metadata_path(root)
    if not path.exists():
        return {}
    return read_json_file(path)


def save_metadata(root: Path, metadata: dict) -> None:
    write_json_file(metadata_path(root), metadata)


def parse_uploaded_json(uploaded_file) -> dict:
    data = json.loads(uploaded_file.read().decode("utf-8"))
    if not isinstance(data, dict) or "participants" not in data:
        raise ValueError("Uploaded JSON must be an object with a participants key.")
    return data


def safe_filename(filename: str) -> str:
    return get_valid_filename(Path(filename).name)


def save_uploaded_audio_files(uploaded_files, destination: Path) -> list[str]:
    audio_files = []
    for uploaded_file in uploaded_files:
        filename = safe_filename(uploaded_file.name)
        if Path(filename).suffix.lower() not in AUDIO_EXTENSIONS:
            continue
        target = destination / filename
        with target.open("wb") as handle:
            for chunk in uploaded_file.chunks():
                handle.write(chunk)
        audio_files.append(filename)
    return sorted(audio_files)


def normalize_for_match(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def match_audio_file(email: str, audio_files: list[str]) -> str | None:
    normalized_email = normalize_for_match(email)
    for filename in audio_files:
        if normalized_email in normalize_for_match(Path(filename).stem):
            return filename

    username = normalize_for_match(email.split("@", 1)[0])
    for filename in audio_files:
        if username and username in normalize_for_match(Path(filename).stem):
            return filename
    return None


def get_segments(participant: dict) -> list[dict]:
    return participant.get("annotation", {}).setdefault("updatedTranscription", [])


def rebuild_segment_text(segment: dict) -> None:
    words = segment.get("words", [])
    segment["text"] = " ".join(word.get("text", "") for word in words).strip()
    if words:
        segment["start"] = min(int(word.get("start", 0)) for word in words)
        segment["end"] = max(int(word.get("end", 0)) for word in words)


def rebuild_all_segment_text(segments: list[dict]) -> None:
    for segment in segments:
        rebuild_segment_text(segment)


def audio_peaks_from_file(audio_path: Path, peak_count: int = 900) -> tuple[list[float], float]:
    with audio_path.open("rb") as handle:
        audio_bytes = handle.read()

    with wave.open(BytesIO(audio_bytes), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        frame_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        duration = frame_count / frame_rate if frame_rate else 0
        raw = wav_file.readframes(frame_count)

    if not raw or sample_width not in {1, 2, 4}:
        return [], duration

    if sample_width == 1:
        samples = [byte - 128 for byte in raw]
        max_value = 128
    elif sample_width == 2:
        samples = [
            int.from_bytes(raw[i : i + 2], "little", signed=True)
            for i in range(0, len(raw), 2)
        ]
        max_value = 32768
    else:
        samples = [
            int.from_bytes(raw[i : i + 4], "little", signed=True)
            for i in range(0, len(raw), 4)
        ]
        max_value = 2147483648

    if channels > 1:
        samples = samples[::channels]
    if not samples:
        return [], duration

    bucket_size = max(1, math.ceil(len(samples) / peak_count))
    peaks = []
    for start in range(0, len(samples), bucket_size):
        bucket = samples[start : start + bucket_size]
        peaks.append(min(1.0, max(abs(sample) for sample in bucket) / max_value))
    return peaks, duration


def audio_file_response(request: HttpRequest, audio_path: Path) -> HttpResponse:
    file_size = audio_path.stat().st_size
    content_type = mimetypes.guess_type(audio_path.name)[0] or "audio/wav"
    range_header = request.headers.get("Range", "")
    range_match = RANGE_RE.match(range_header)

    if range_match:
        first_byte, last_byte = range_match.groups()
        if first_byte:
            start = int(first_byte)
            end = int(last_byte) if last_byte else file_size - 1
        else:
            suffix_length = int(last_byte) if last_byte else file_size
            start = max(0, file_size - suffix_length)
            end = file_size - 1

        if start >= file_size or end < start:
            response = HttpResponse(status=416)
            response["Content-Range"] = f"bytes */{file_size}"
            response["Accept-Ranges"] = "bytes"
            return response

        end = min(end, file_size - 1)
        length = end - start + 1
        with audio_path.open("rb") as handle:
            handle.seek(start)
            content = handle.read(length)

        response = HttpResponse(content, status=206, content_type=content_type)
        response["Content-Length"] = str(length)
        response["Content-Range"] = f"bytes {start}-{end}/{file_size}"
        response["Accept-Ranges"] = "bytes"
        return response

    response = FileResponse(audio_path.open("rb"), content_type=content_type)
    response["Content-Length"] = str(file_size)
    response["Accept-Ranges"] = "bytes"
    return response


def participant_options(data: dict) -> list[dict]:
    options = []
    for participant_id, participant in data.get("participants", {}).items():
        email = participant.get("email", "unknown")
        role = participant.get("role", "unknown role")
        options.append(
            {
                "id": participant_id,
                "label": f"{email} ({role}, id {participant_id})",
                "email": email,
                "role": role,
            }
        )
    return options


def state_payload(data: dict, metadata: dict) -> dict:
    return {
        "jsonName": metadata.get("json_name"),
        "downloadName": metadata.get("download_name", "labeling.fixed.json"),
        "outputName": metadata.get("download_name", "labeling.fixed.json"),
        "outputFolder": metadata.get("output_folder"),
        "outputFilePath": metadata.get("output_file_path"),
        "audioFiles": metadata.get("audio_files", []),
        "participants": participant_options(data),
        "downloadUrl": reverse("editor:download_json"),
    }


def require_workspace_data(request: HttpRequest) -> tuple[Path, dict, dict] | JsonResponse:
    root = workspace_root(request)
    metadata = load_metadata(root)
    data_file = output_data_path(root, metadata)
    if not data_file.exists():
        return JsonResponse({"error": "Upload a JSON file and WAV files to begin."}, status=404)
    return root, read_json_file(data_file), metadata


@require_GET
def state(request: HttpRequest) -> JsonResponse:
    result = require_workspace_data(request)
    if isinstance(result, JsonResponse):
        return result
    root, data, metadata = result
    return JsonResponse(state_payload(data, metadata))


@require_POST
def select_output_folder(request: HttpRequest) -> JsonResponse:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        return JsonResponse({"error": f"Folder picker is not available: {exc}"}, status=500)

    root_window = tk.Tk()
    root_window.withdraw()
    root_window.attributes("-topmost", True)
    try:
        folder = filedialog.askdirectory(title="Choose output folder")
    finally:
        root_window.destroy()

    if not folder:
        return JsonResponse({"folder": ""})
    return JsonResponse({"folder": folder})


@require_POST
def load_files(request: HttpRequest) -> JsonResponse:
    uploaded_json = request.FILES.get("json_file")
    if uploaded_json is None:
        return JsonResponse({"error": "Please upload a JSON file."}, status=400)

    try:
        output_folder = ensure_output_folder(request.POST.get("output_folder", ""))
        data = parse_uploaded_json(uploaded_json)
        root = workspace_root(request)
        if root.exists():
            shutil.rmtree(root)
        root.mkdir(parents=True, exist_ok=True)
        destination = audio_root(root)
        audio_files = save_uploaded_audio_files(request.FILES.getlist("audio_files"), destination)

        json_name = Path(uploaded_json.name).name
        output_file_path = unique_output_path(output_folder, f"{Path(json_name).stem}.fixed.json")
        download_name = output_file_path.name
        write_json_file(original_data_path(root), data)
        write_json_file(output_file_path, data)
        save_metadata(
            root,
            {
                "json_name": json_name,
                "download_name": download_name,
                "output_folder": str(output_folder),
                "output_file_path": str(output_file_path),
                "audio_files": audio_files,
            },
        )
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, RuntimeError) as exc:
        return JsonResponse({"error": f"Could not load files: {exc}"}, status=400)

    return JsonResponse(state_payload(data, load_metadata(root)))


@require_GET
def participant_detail(request: HttpRequest, participant_id: str) -> JsonResponse:
    result = require_workspace_data(request)
    if isinstance(result, JsonResponse):
        return result
    root, data, metadata = result

    participant = data.get("participants", {}).get(participant_id)
    if participant is None:
        return JsonResponse({"error": "Participant not found."}, status=404)

    email = participant.get("email", "unknown")
    segments = get_segments(participant)
    audio_name = match_audio_file(email, metadata.get("audio_files", []))
    audio = None
    if audio_name:
        audio_path = audio_root(root) / audio_name
        try:
            peaks, duration = audio_peaks_from_file(audio_path)
            audio = {
                "name": audio_name,
                "title": f"{email} - {audio_name}",
                "url": reverse("editor:audio_file", kwargs={"filename": audio_name}),
                "peaks": peaks,
                "duration": duration,
            }
        except (FileNotFoundError, wave.Error, OSError) as exc:
            audio = {"error": f"Could not load audio file: {exc}"}

    return JsonResponse(
        {
            "participantId": participant_id,
            "email": email,
            "segments": segments,
            "audio": audio,
            "warning": None
            if audio_name
            else (
                f"No matching .wav file found for {email}. Add a .wav file whose "
                "name contains this email address or username."
            ),
        }
    )


@require_safe
def serve_audio(request: HttpRequest, filename: str) -> HttpResponse:
    root = workspace_root(request)
    metadata = load_metadata(root)
    audio_files = metadata.get("audio_files", [])
    audio_name = Path(filename).name
    if audio_name not in audio_files:
        raise Http404("Audio file not found.")

    audio_path = audio_root(root) / audio_name
    if not audio_path.exists():
        raise Http404("Audio file not found.")

    return audio_file_response(request, audio_path)


@require_POST
def save_participant(request: HttpRequest, participant_id: str) -> JsonResponse:
    result = require_workspace_data(request)
    if isinstance(result, JsonResponse):
        return result
    root, data, metadata = result

    participant = data.get("participants", {}).get(participant_id)
    if participant is None:
        return JsonResponse({"error": "Participant not found."}, status=404)

    try:
        payload = json.loads(request.body.decode("utf-8"))
        incoming_segments = payload.get("segments", [])
        if not isinstance(incoming_segments, list):
            raise ValueError("Segments must be a list.")
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        return JsonResponse({"error": f"Could not save edits: {exc}"}, status=400)

    segments = get_segments(participant)
    if len(incoming_segments) != len(segments):
        return JsonResponse({"error": "Could not save: segment count changed unexpectedly."}, status=400)

    for segment, incoming_segment in zip(segments, incoming_segments):
        segment["words"] = [
            {
                "text": str(word.get("text", "")),
                "start": int(word.get("start", 0)),
                "end": int(word.get("end", 0)),
                "confidence": float(word.get("confidence", 1.0)),
                **({"isUserAdded": True} if word.get("isUserAdded") else {}),
            }
            for word in incoming_segment.get("words", [])
        ]

    rebuild_all_segment_text(segments)
    write_json_file(output_data_path(root, metadata), data)
    return JsonResponse(
        {
            "message": "Autosaved output JSON.",
            "downloadName": metadata.get("download_name", "labeling.fixed.json"),
            "downloadUrl": reverse("editor:download_json"),
        }
    )


@require_GET
def download_json(request: HttpRequest) -> FileResponse:
    root = workspace_root(request)
    metadata = load_metadata(root)
    file_path = output_data_path(root, metadata)
    if not file_path.exists():
        raise Http404("No edited JSON is available.")

    response = FileResponse(file_path.open("rb"), content_type="application/json")
    response["Content-Disposition"] = (
        f'attachment; filename="{metadata.get("download_name", "labeling.fixed.json")}"'
    )
    return response
