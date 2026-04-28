from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .auth import AuthService, User
from .simulation import RailFlowSimulation, SimulationError


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MODEL_PATH = BASE_DIR / "models" / "railflow_ppo.zip"


app = FastAPI(title="RailFlow API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

simulation = RailFlowSimulation(DATA_DIR / "railway_graph.json", MODEL_PATH)
auth_service = AuthService(DATA_DIR / "users.json")
state_lock = asyncio.Lock()


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    user: dict[str, Any]


class TrainAddRequest(BaseModel):
    id: str
    name: str | None = None
    type: str = "express"
    priority: int | None = None
    source: str
    destination: str
    scheduled_departure_tick: int = 0
    max_speed: float | None = None
    route: list[str] | None = None


class TrainActionRequest(BaseModel):
    train_id: str


class ManualRouteRequest(BaseModel):
    train_id: str
    route: list[str]


class TrackAddRequest(BaseModel):
    id: str | None = None
    from_node: str = Field(alias="from")
    to_node: str = Field(alias="to")
    distance_km: float
    avg_speed: float
    capacity: int
    bidirectional: bool = True

    model_config = {"populate_by_name": True}


class EdgeActionRequest(BaseModel):
    edge_id: str


class SpeedRestrictionRequest(BaseModel):
    edge_id: str
    speed_limit: float | None = None


class SimulationSpeedRequest(BaseModel):
    seconds: float


class SeedScenarioRequest(BaseModel):
    scenario: str = "mixed_peak"


class EmergencyHaltRequest(BaseModel):
    active: bool = True


class CorridorHaltRequest(BaseModel):
    edge_ids: list[str]


class IncidentAddRequest(BaseModel):
    type: str
    edge_id: str
    severity: str = "warning"
    speed_limit: float | None = None
    note: str = ""


class IncidentResolveRequest(BaseModel):
    incident_id: str


class ConnectionManager:
    def __init__(self):
        self.active: set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.active.discard(websocket)

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for websocket in list(self.active):
            try:
                await websocket.send_json(payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(websocket)


manager = ConnectionManager()


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return None
    return authorization[len(prefix) :]


def require_role(required_role: str) -> Callable[[str | None], User]:
    def dependency(authorization: str | None = Header(default=None)) -> User:
        user = auth_service.user_for_token(bearer_token(authorization))
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required.")
        if not auth_service.can(user, required_role):
            raise HTTPException(status_code=403, detail="Insufficient role.")
        return user

    return dependency


def handle_simulation_error(exc: SimulationError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.message)


@app.on_event("startup")
async def start_background_loop() -> None:
    asyncio.create_task(simulation_loop())


async def simulation_loop() -> None:
    while True:
        async with state_lock:
            simulation.advance_tick()
            payload = {"type": "state_update", **simulation.snapshot()}
            interval = simulation.tick_interval_seconds
        await manager.broadcast(payload)
        await asyncio.sleep(interval)


@app.post("/auth/login", response_model=LoginResponse)
async def login(payload: LoginRequest) -> LoginResponse:
    result = auth_service.login(payload.username, payload.password)
    if result is None:
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    token, user = result
    return LoginResponse(token=token, user=user.to_dict())


@app.post("/auth/logout")
async def logout(authorization: str | None = Header(default=None)) -> dict[str, str]:
    auth_service.logout(bearer_token(authorization) or "")
    return {"status": "ok"}


@app.get("/auth/me")
async def me(user: User = Depends(require_role("viewer"))) -> dict[str, Any]:
    return user.to_dict()


@app.get("/state")
async def get_state(user: User = Depends(require_role("viewer"))) -> dict[str, Any]:
    async with state_lock:
        return simulation.snapshot()


@app.get("/graph")
async def get_graph(user: User = Depends(require_role("viewer"))) -> dict[str, Any]:
    async with state_lock:
        return simulation.snapshot()["graph"]


@app.get("/logs")
async def get_logs(user: User = Depends(require_role("viewer"))) -> list[dict[str, Any]]:
    async with state_lock:
        return simulation.logs.all()


@app.post("/simulation/pause")
async def pause(user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        simulation.set_paused(True)
        return simulation.snapshot()


@app.post("/simulation/resume")
async def resume(user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        simulation.set_paused(False)
        return simulation.snapshot()


@app.post("/simulation/reset")
async def reset(user: User = Depends(require_role("admin"))) -> dict[str, Any]:
    async with state_lock:
        simulation.reset()
        return simulation.snapshot()


@app.post("/simulation/seed")
async def seed(payload: SeedScenarioRequest | None = None, user: User = Depends(require_role("admin"))) -> dict[str, Any]:
    async with state_lock:
        simulation.seed_scenario(payload.scenario if payload else "mixed_peak")
        return simulation.snapshot()


@app.post("/simulation/speed")
async def set_speed(payload: SimulationSpeedRequest, user: User = Depends(require_role("admin"))) -> dict[str, Any]:
    async with state_lock:
        simulation.set_tick_interval(payload.seconds)
        return simulation.snapshot()


@app.post("/simulation/emergency-halt")
async def emergency_halt(
    payload: EmergencyHaltRequest,
    user: User = Depends(require_role("admin")),
) -> dict[str, Any]:
    async with state_lock:
        simulation.emergency_halt(payload.active)
        return simulation.snapshot()


@app.post("/simulation/corridor-halt")
async def corridor_halt(
    payload: CorridorHaltRequest,
    user: User = Depends(require_role("admin")),
) -> dict[str, Any]:
    async with state_lock:
        simulation.corridor_halt(payload.edge_ids)
        return simulation.snapshot()


@app.post("/train/add")
async def add_train(payload: TrainAddRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            train = simulation.add_train(payload.model_dump(exclude_none=True))
        except SimulationError as exc:
            raise handle_simulation_error(exc)
        return train.to_dict()


@app.post("/train/stop")
async def stop_train(payload: TrainActionRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            return simulation.stop_train(payload.train_id).to_dict()
        except SimulationError as exc:
            raise handle_simulation_error(exc)


@app.post("/train/resume")
async def resume_train(payload: TrainActionRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            return simulation.resume_train(payload.train_id).to_dict()
        except SimulationError as exc:
            raise handle_simulation_error(exc)


@app.post("/train/reroute")
async def reroute_train(payload: TrainActionRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            return simulation.reroute_train(payload.train_id).to_dict()
        except SimulationError as exc:
            raise handle_simulation_error(exc)


@app.post("/train/manual-route")
async def manual_route(payload: ManualRouteRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            return simulation.set_manual_route(payload.train_id, payload.route).to_dict()
        except SimulationError as exc:
            raise handle_simulation_error(exc)


@app.post("/track/add")
async def add_track(payload: TrackAddRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            return simulation.add_track(payload.model_dump(by_alias=True, exclude_none=True))
        except SimulationError as exc:
            raise handle_simulation_error(exc)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))


@app.post("/track/remove")
async def remove_track(payload: EdgeActionRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            simulation.remove_track(payload.edge_id)
            return simulation.snapshot()
        except SimulationError as exc:
            raise handle_simulation_error(exc)


@app.post("/track/close")
async def close_track(payload: EdgeActionRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            edge = simulation.close_track(payload.edge_id)
            return simulation.graph.edge_snapshot(edge, simulation.occupancy().get(edge.id, 0))
        except SimulationError as exc:
            raise handle_simulation_error(exc)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))


@app.post("/track/reopen")
async def reopen_track(payload: EdgeActionRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            edge = simulation.reopen_track(payload.edge_id)
            return simulation.graph.edge_snapshot(edge, simulation.occupancy().get(edge.id, 0))
        except SimulationError as exc:
            raise handle_simulation_error(exc)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))


@app.post("/track/restrict-speed")
async def restrict_speed(
    payload: SpeedRestrictionRequest,
    user: User = Depends(require_role("dispatcher")),
) -> dict[str, Any]:
    async with state_lock:
        try:
            edge = simulation.restrict_track_speed(payload.edge_id, payload.speed_limit)
            return simulation.graph.edge_snapshot(edge, simulation.occupancy().get(edge.id, 0))
        except SimulationError as exc:
            raise handle_simulation_error(exc)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc))


@app.post("/incident/add")
async def add_incident(payload: IncidentAddRequest, user: User = Depends(require_role("dispatcher"))) -> dict[str, Any]:
    async with state_lock:
        try:
            return simulation.add_incident(payload.model_dump(exclude_none=True))
        except SimulationError as exc:
            raise handle_simulation_error(exc)


@app.post("/incident/resolve")
async def resolve_incident(
    payload: IncidentResolveRequest,
    user: User = Depends(require_role("dispatcher")),
) -> dict[str, Any]:
    async with state_lock:
        try:
            return simulation.resolve_incident(payload.incident_id)
        except SimulationError as exc:
            raise handle_simulation_error(exc)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        async with state_lock:
            await websocket.send_json({"type": "state_update", **simulation.snapshot()})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
