from django.urls import path

from . import views

app_name = "editor"

urlpatterns = [
    path("", views.index, name="index"),
    path("api/select-output-folder/", views.select_output_folder, name="select_output_folder"),
    path("api/load/", views.load_files, name="load_files"),
    path("api/state/", views.state, name="state"),
    path("api/participant/<str:participant_id>/", views.participant_detail, name="participant_detail"),
    path("api/save/<str:participant_id>/", views.save_participant, name="save_participant"),
    path("audio/<path:filename>/", views.serve_audio, name="audio_file"),
    path("download/", views.download_json, name="download_json"),
]
