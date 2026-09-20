# RailFlow

RailFlow is a local railway traffic control simulation for the Delhi to Lucknow operating region. It uses a weighted railway graph, deterministic train movement, Dijkstra routing, congestion-aware rerouting, a safe RL wrapper with heuristic fallback, FastAPI, WebSockets, and a React operations console.

<img width="1898" height="858" alt="image" src="https://github.com/user-attachments/assets/0b26a725-8878-4973-b145-bc486b1e6e97" />

## Run Backend

Fast start:

```powershell
cd RailFlow
.\start.ps1
```

Clean shutdown:

```powershell
cd RailFlow
.\stop.ps1
```

Manual backend start:

```powershell
cd RailFlow
pip install -r backend\requirements.txt
python -m uvicorn backend.main:app --reload
```

The API runs at:

```text
http://127.0.0.1:8000
```

## Run Frontend

```powershell
cd RailFlow\frontend
npm install
npm run dev
```

The app runs at:

```text
http://127.0.0.1:5173
```

## Verify

Frontend (tests plus a production build):

```powershell
cd RailFlowrontend
npm run verify
```

`npm test` alone runs the corridor geometry and physics tests with Node's built-in
test runner, so no test dependency is installed.

Backend simulation invariants:

```powershell
cd RailFlow
python -m backend.selftest
```

Benchmark against the real etrain.info corridor data:

```powershell
cd RailFlow
python -m backend.benchmark
```

## Configuration

The console talks to `127.0.0.1:8000` by default. To point it at a backend
elsewhere, set `VITE_API_HOST` at build or dev time:

```powershell
$env:VITE_API_HOST = "192.168.1.20:8000"; npm run dev
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
cd RailFlow
pip install -r backend\requirements-rl.txt
python -m backend.train_ppo
```

The model is saved to:

```text
backend\models\railflow_ppo.zip
```
