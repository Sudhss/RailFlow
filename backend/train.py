from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


TRAIN_TYPE_PROFILES: dict[str, dict[str, Any]] = {
    "superfast": {
        "priority": 5,
        "max_speed": 120,
        "minor_stop": False,
        "dwell_multiplier": 0.8,
    },
    "express": {
        "priority": 4,
        "max_speed": 105,
        "minor_stop": False,
        "dwell_multiplier": 1.0,
    },
    "passenger": {
        "priority": 3,
        "max_speed": 80,
        "minor_stop": True,
        "dwell_multiplier": 1.3,
    },
    "freight": {
        "priority": 2,
        "max_speed": 65,
        "minor_stop": False,
        "dwell_multiplier": 1.8,
    },
    "maintenance": {
        "priority": 1,
        "max_speed": 40,
        "minor_stop": True,
        "dwell_multiplier": 1.5,
    },
}


@dataclass
class Train:
    id: str
    name: str
    type: str
    priority: int
    source: str
    destination: str
    route: list[str]
    scheduled_departure_tick: int
    max_speed: float
    status: str = "scheduled"
    current_node: str | None = None
    next_node: str | None = None
    edge_id: str | None = None
    edge_progress: float = 0.0
    current_speed: float = 0.0
    delay: int = 0
    route_index: int = 0
    dwell_remaining: int = 0
    hold_at: str | None = None
    pending_reroute: bool = False
    requested_route: list[str] | None = None
    last_reroute_tick: int = -9999
    completed_tick: int | None = None
    last_agent_action: dict[str, Any] | None = field(default=None)

    @property
    def departed(self) -> bool:
        return self.status not in {"scheduled"}

    @property
    def complete(self) -> bool:
        return self.status == "arrived"

    @property
    def on_edge(self) -> bool:
        return self.edge_id is not None and self.next_node is not None

    def allowed_route_starts(self) -> set[str]:
        starts = set()
        if self.current_node:
            starts.add(self.current_node)
        if self.next_node:
            starts.add(self.next_node)
        return starts

    def start(self) -> None:
        self.current_node = self.route[0]
        self.route_index = 0
        if len(self.route) == 1:
            self.status = "arrived"
            self.current_speed = 0
            return
        self.status = "moving"
        self.next_node = self.route[1]
        self.edge_progress = 0.0

    def stop(self) -> None:
        if self.status != "arrived":
            self.status = "stopped"
            self.current_speed = 0.0

    def resume(self) -> None:
        if self.status == "stopped":
            if self.dwell_remaining > 0:
                self.status = "dwelling"
            elif self.next_node:
                self.status = "moving"
            else:
                self.status = "scheduled"

    def apply_route_from_node(self, new_route: list[str], tick: int) -> None:
        self.route = new_route
        self.route_index = 0
        self.current_node = new_route[0]
        self.next_node = new_route[1] if len(new_route) > 1 else None
        self.edge_id = None
        self.edge_progress = 0.0
        self.pending_reroute = False
        self.requested_route = None
        self.last_reroute_tick = tick
        self.hold_at = None
        if self.next_node:
            self.status = "moving"
        else:
            self.status = "arrived"

    def queue_route_after_edge(self, new_route: list[str]) -> None:
        self.pending_reroute = True
        self.requested_route = new_route

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["on_edge"] = self.on_edge
        payload["departed"] = self.departed
        payload["complete"] = self.complete
        return payload


def profile_for_train_type(train_type: str) -> dict[str, Any]:
    if train_type not in TRAIN_TYPE_PROFILES:
        raise ValueError(f"Unknown train type: {train_type}")
    return TRAIN_TYPE_PROFILES[train_type]
