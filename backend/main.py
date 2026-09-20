from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Callable

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .auth import AuthService, User
from .simulation import RailFlowSimulation, SimulationError


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MODEL_PATH = BASE_DIR / "models" / "railflow_ppo.zip"


logger = logging.getLogger("railflow")


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    task = asyncio.create_task(simulation_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="RailFlow API", version="1.0.0", lifespan=lifespan)
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


@app.exception_handler(SimulationError)
async def simulation_error_handler(_: Request, exc: SimulationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class LoginResponse(BaseModel):
    token: str
    user: dict[str, Any]


class TrainAddRequest(BaseModel):
    id: str = Field(min_length=1, max_length=32)
    name: str | None = Field(default=None, max_length=64)
    type: str = "express"
    priority: int | None = Field(default=None, ge=1, le=5)
    source: str = Field(min_length=1, max_length=16)
    destination: str = Field(min_length=1, max_length=16)
    scheduled_departure_tick: int = Field(default=0, ge=0)
    max_speed: float | None = Field(default=None, gt=0, le=250)
    route: list[str] | None = Field(default=None, max_length=256)


class TrainActionRequest(BaseModel):
    train_id: str = Field(min_length=1, max_length=32)


class ManualRouteRequest(BaseModel):
    train_id: str = Field(min_length=1, max_length=32)
    route: list[str] = Field(min_length=1, max_length=256)


class TrackAddRequest(BaseModel):
    id: str | None = None
    from_node: str = Field(alias="from")
    to_node: str = Field(alias="to")
    distance_km: float = Field(gt=0, le=2000)
    avg_speed: float = Field(gt=0, le=350)
    capacity: int = Field(ge=1, le=64)
    bidirectional: bool = True

    model_config = {"populate_by_name": True}


class EdgeActionRequest(BaseModel):
    edge_id: str = Field(min_length=1, max_length=64)


class SpeedRestrictionRequest(BaseModel):
    edge_id: str = Field(min_length=1, max_length=64)
    speed_limit: float | None = Field(default=None, gt=0, le=350)


class SimulationSpeedRequest(BaseModel):
    seconds: float = Field(gt=0, le=60)


class SeedScenarioRequest(BaseModel):
    scenario: str = Field(default="mixed_peak", min_length=1, max_length=64)


class EmergencyHaltRequest(BaseModel):
    active: bool = True


class CorridorHaltRequest(BaseModel):
    edge_ids: list[str] = Field(min_length=1, max_length=256)


class IncidentAddRequest(BaseModel):
    type: str = Field(min_length=1, max_length=48)
    edge_id: str = Field(min_length=1, max_length=64)
    severity: str = Field(default="warning", max_length=16)
    speed_limit: float | None = Field(default=None, gt=0, le=350)
    note: str = Field(default="", max_length=280)


class IncidentResolveRequest(BaseModel):
    incident_id: str = Field(min_length=1, max_length=64)


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


async def simulation_loop() -> None:
    """Advance the simulation forever.

    A failure inside one tick must not kill the loop: if this task dies the
    whole console freezes while still reporting itself as live.
    """
    while True:
        interval = simulation.tick_interval_seconds
        try:
            async with state_lock:
                simulation.advance_tick()
                payload = {"type": "state_update", **simulation.snapshot()}
                interval = simulation.tick_interval_seconds
            await manager.broadcast(payload)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Simulation tick failed; continuing.")
            async with state_lock:
                simulation.logs.add(
                    tick=simulation.tick,
                    sim_time=simulation.sim_time,
                    type="system_error",
                    severity="critical",
                    message="A simulation tick failed. The run continued from the last good state.",
                )
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
async def websocket_endpoint(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    # The stream carries the full operational picture, so it needs the same
    # authentication as GET /state rather than being open to any caller.
    if auth_service.user_for_token(token) is None:
        # Accept first, then close with a policy code. Rejecting before the
        # handshake completes only reaches the browser as an opaque 1006, so the
        # console cannot tell "your session expired" from "the server is down".
        await websocket.accept()
        await websocket.close(code=1008, reason="Invalid or expired token.")
        return
    await manager.connect(websocket)
    try:
        async with state_lock:
            await websocket.send_json({"type": "state_update", **simulation.snapshot()})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket stream failed.")
    finally:
        manager.disconnect(websocket)
