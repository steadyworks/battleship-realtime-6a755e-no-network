#!/bin/bash
set -e

cd /app/backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 3001 &

cd /app/frontend
npm install
npm run build && npx vite preview --port 3000 --host 0.0.0.0 --strictPort &
