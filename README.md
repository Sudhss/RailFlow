# RailFlow

RailFlow is a local railway traffic control simulation for the Delhi to Lucknow operating region. It uses a weighted railway graph, deterministic train movement, Dijkstra routing, congestion-aware rerouting, a safe RL wrapper with heuristic fallback, FastAPI, WebSockets, and a React operations console.

<img width="1898" height="858" alt="image" src="https://github.com/user-attachments/assets/0b26a725-8878-4973-b145-bc486b1e6e97" />

## Run Backend

Fast start:

```powershell
cd C:\Users\shukl\Documents\Codex\2026-04-29\RailFlow
.\start.ps1
```

Clean shutdown:

```powershell
cd C:\Users\shukl\Documents\Codex\2026-04-29\RailFlow
.\stop.ps1
```

Manual backend start:

```powershell
cd C:\Users\shukl\Documents\Codex\2026-04-29\RailFlow
pip install -r backend\requirements.txt
python -m uvicorn backend.main:app --reload
```

The API runs at:

```text
http://127.0.0.1:8000
```

## Run Frontend

```powershell
cd C:\Users\shukl\Documents\Codex\2026-04-29\RailFlow\frontend
npm install
npm run dev
```

The app runs at:

```text
http://127.0.0.1:5173
```

## Local Users

```text
admin / admin
dispatcher / dispatcher
viewer / viewer
```

## PPO Training

The runtime works without a trained PPO model by using the heuristic safety controller. To train a PPO model:

```powershell
cd C:\Users\shukl\Documents\Codex\2026-04-29\RailFlow
pip install -r backend\requirements-rl.txt
python -m backend.train_ppo
```

The model is saved to:

```text
backend\models\railflow_ppo.zip
```
