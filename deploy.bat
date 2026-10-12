@echo off
cd /d "%~dp0"
uv venv --python 3.12 --allow-existing .venv
uv pip install --python ".venv\Scripts\python.exe" --link-mode copy -r requirements.txt
".venv\Scripts\python.exe" start.py
