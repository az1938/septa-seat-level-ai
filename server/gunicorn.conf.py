# Gunicorn settings for the Render backend (picked up automatically when gunicorn
# starts in the server/ directory, e.g. `gunicorn app:app`).
#
# The shared prototype session (session_store.py) lives in memory, so ALL requests
# must reach ONE process: exactly 1 worker. Threads let the 1 s polls from
# /monitor, /input and /output be answered while an AI or SEPTA request is running.
workers = 1
threads = 8
worker_class = "gthread"
timeout = 60
