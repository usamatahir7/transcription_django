# Django Audio JSON Transcript Editor

A Django audio JSON editor. It lets you upload a labeling JSON file and matching WAV files, edit word-level transcript text and timings, and download the fixed JSON.

## Local Setup

```powershell
.\.venv\Scripts\activate
pip install -r requirements.txt
python manage.py runserver
```

Open:

```text
http://127.0.0.1:8000/
```

Uploaded JSON and audio files are stored in per-session folders under `media/`. Session files are stored under `sessions/`.
