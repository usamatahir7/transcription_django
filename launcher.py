import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

from django.core.management import call_command


def application_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def main() -> None:
    app_root = application_root()
    runtime_dir = app_root / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    (runtime_dir / "sessions").mkdir(parents=True, exist_ok=True)
    (runtime_dir / "media").mkdir(parents=True, exist_ok=True)

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "transcription_site.settings")
    os.environ.setdefault("TRANSCRIPT_EDITOR_RUNTIME_DIR", str(runtime_dir))

    import django

    django.setup()

    port = int(os.environ.get("TRANSCRIPT_EDITOR_PORT") or find_free_port())
    url = f"http://127.0.0.1:{port}/"
    if os.environ.get("TRANSCRIPT_EDITOR_NO_BROWSER") != "1":
        threading.Timer(1.25, lambda: webbrowser.open(url)).start()
    call_command("runserver", f"127.0.0.1:{port}", use_reloader=False)


if __name__ == "__main__":
    main()
